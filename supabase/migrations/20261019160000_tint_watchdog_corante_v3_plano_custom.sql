-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — WATCHDOG de corante impagável, v3 (sucede a 20261019150000, mesma data)
--
-- POR QUE UMA v3 NO MESMO DIA. A v2 foi aplicada em prod (2026-10-19 ~21:40 UTC, ensaio +
-- md5 + 2ª testemunha) e o índice idx_tint_formula_itens_corante ficou válido — mas a
-- medição DEPOIS do apply (psql-ro, EXPLAIN) mostrou que o planner NÃO o usa: no
-- CROSS JOIN LATERAL o corante_id é parâmetro GENÉRICO, estimado pela média
-- (3,5M itens / 17 corantes distintos ≈ 37 mil por corante), então para CADA corante
-- ruim ele monta um hash das 482 mil fórmulas ativas. Com 12 corantes ruins o detector
-- continuou passando do statement timeout — o cron seguiu falhando com a v2.
--
-- O QUE MUDA (só a DETECÇÃO; o resto é a v2 byte a byte):
--   a) Candidatos primeiro: o predicado do corante roda sobre tint_corantes (26 linhas) e
--      vira um uuid[] (v_cand). Só então tint_formula_itens é lido, por
--      corante_id = ANY (v_cand), num único GROUP BY.
--   b) A função leva SET plan_cache_mode = force_custom_plan: o planner sempre planeja
--      com os VALORES de v_cand. As estatísticas de prod têm os 14 corantes antigos no MCV
--      (99,99% das linhas), então um corante raro é estimado em ~100 itens -> bitmap scan
--      no índice novo + nested loop pela PK de tint_formulas. Medido em prod com os 12
--      candidatos reais: 1,8 s (cache frio), 0 corantes ruins pela regra da v2.
--      Se um corante GRANDE cair (ex.: 297k fórmulas), o mesmo valor real faz o planner
--      escolher hash — o plano certo para esse caso.
--   c) Rótulo, base precificável e contagem distinta: idênticos à v2.
--
-- Prova: db/test-tint-watchdog-corante.sh (PG17, aplica v1 -> v2 -> ESTA, falsificação).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '10s';
-- exclusão real do worker de promoção (ele usa try_lock: pula o tick enquanto seguramos)
SELECT pg_advisory_xact_lock(hashtext('tint_promocao_tick'));

-- TRAVA antes de ler (ALTER sem efeito: a função já é VOLATILE) — ninguém troca a função
-- entre a PRE e o CREATE.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_watchdog_corante_check()') IS NOT NULL THEN
    ALTER FUNCTION public.tint_watchdog_corante_check() VOLATILE;
  END IF;
END
$trava$;

-- PRE anti-deriva: md5 do corpo vivo ∈ {v2 aplicada em prod 2026-10-19, esta v3}. Outro ABORTA.
DO $pre$
DECLARE vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                       WHERE p.oid = to_regprocedure('public.tint_watchdog_corante_check()'));
BEGIN
  IF vivo IS NULL OR vivo NOT IN ('8febcd9e495c4536f3a548b1afab278e', 'eeddd88a26585696edfd88fc270570ce') THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_corante_check() vivo (md5 %) nao e a v2 aplicada nem esta v3', vivo;
  END IF;
END
$pre$;

CREATE INDEX IF NOT EXISTS idx_tint_formula_itens_corante
  ON public.tint_formula_itens (corante_id);

CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  -- tint_watchdog_corante guard v3 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v4, v5...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  v_conta        text := 'oben';   -- 100% do catálogo tint é oben (medido)
  v_ruins        int;
  v_cand         uuid[];
  v_ids          uuid[];
  v_formulas     bigint;
  v_lista        text;
  v_msg          text;
  v_sev_fin      text;
  v_sev_forn     text;
  v_ant_n        int;
  v_b_atraso     interval;
BEGIN
  -- ── DETECÇÃO ────────────────────────────────────────────────────────────
  -- Corante cujo custo Omie não precifica, E que está EM USO por fórmula ativa cuja BASE
  -- precifica. O predicado do corante espelha corantes_completos da RPC get_tint_price /
  -- receita_valida da v_tint_formula_canonica: valor_unitario>0 E omie ativo E
  -- volume_total_ml>0. O da base espelha v_base_disponivel da mesma RPC: se a base não
  -- precifica, a fórmula já está sem preço e o corante NÃO é o bloqueio (v2: linha nova da
  -- Sayerlack sem base no Omie alarmava como corante caído).
  -- O filtro de USO evita alarmar por corante recém-cadastrado que ninguém dosa.
  -- v3: candidatos PRIMEIRO (26 linhas) e itens por corante_id = ANY (v_cand), planejado
  -- com os valores reais (force_custom_plan) -> índice idx_tint_formula_itens_corante.
  -- A v2 usava LATERAL com parâmetro genérico e o planner ignorava o índice.
  SELECT array_agg(c.id)
    INTO v_cand
    FROM tint_corantes c
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
   WHERE NOT (COALESCE(op.valor_unitario, 0) > 0
              AND COALESCE(op.ativo, false)
              AND c.volume_total_ml IS NOT NULL
              AND c.volume_total_ml > 0);

  WITH uso AS (
    SELECT fi.corante_id, count(*) AS formulas
      FROM tint_formula_itens fi
      JOIN tint_formulas f    ON f.id = fi.formula_id
      JOIN tint_skus s        ON s.id = f.sku_id
      JOIN omie_products bp   ON bp.id = s.omie_product_id
     WHERE fi.corante_id = ANY (v_cand)
       AND f.desativada_em IS NULL
       AND bp.valor_unitario > 0 AND COALESCE(bp.ativo, false)
     GROUP BY fi.corante_id
  )
  SELECT count(*),
         array_agg(c.id),
         string_agg(
           COALESCE(NULLIF(btrim(op.descricao), ''), op.codigo,
                    NULLIF(btrim(c.descricao), ''), c.id::text)
             || ' (' || CASE
                  WHEN c.omie_product_id IS NULL              THEN 'sem vinculo Omie'
                  WHEN op.id IS NULL                          THEN 'produto Omie inexistente'
                  WHEN NOT COALESCE(op.ativo, false)          THEN 'inativo no Omie'
                  WHEN COALESCE(op.valor_unitario, 0) <= 0    THEN 'sem custo'
                  ELSE 'volume_total_ml invalido' END || ')',
           '; ' ORDER BY u.formulas DESC)
    INTO v_ruins, v_ids, v_lista
    FROM tint_corantes c
    JOIN uso u ON u.corante_id = c.id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
   WHERE c.id = ANY (v_cand);

  -- Fórmulas DISTINTAS atingidas (v2: a v1 somava pares fórmula×corante). Mesmo universo do
  -- CTE uso acima; v_ids NULL (nenhum corante ruim) => ANY(NULL) => 0.
  SELECT count(DISTINCT fi.formula_id)
    INTO v_formulas
    FROM tint_formula_itens fi
    JOIN tint_formulas f    ON f.id = fi.formula_id
    JOIN tint_skus s        ON s.id = f.sku_id
    JOIN omie_products bp   ON bp.id = s.omie_product_id
   WHERE fi.corante_id = ANY (v_ids)
     AND f.desativada_em IS NULL
     AND bp.valor_unitario > 0 AND COALESCE(bp.ativo, false);

  IF v_ruins > 0 THEN
    -- Agravamento (Codex [P2]): 1 corante numa fórmula != 1 corante em 300 mil.
    v_sev_fin  := CASE WHEN v_formulas >= 1000 THEN 'critico'  ELSE 'aviso'   END;
    v_sev_forn := CASE WHEN v_formulas >= 1000 THEN 'urgente'  ELSE 'atencao' END;
    v_msg := 'Tintometrico: ' || v_ruins || ' corante(s) sem custo utilizavel atingindo '
             || v_formulas || ' formula(s) ativa(s) - essas formulas deixam de ter preco '
             || '(precoFinal NULL, fail-closed) e o balcao nao vende. Apos a Fase 5 a '
             || 'geracao 1 nao e mais fallback. Corante(s): ' || COALESCE(v_lista, '?');

    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
    VALUES (v_conta, 'tint_corante_impagavel', v_sev_fin, v_msg,
            jsonb_build_object('corantes', v_ruins, 'formulas_ativas', v_formulas,
                               'detalhe', v_lista, 'avaliado_em', now()))
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;

    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (v_conta, 'outro', v_sev_forn,
              '[Tintometrico] corante sem custo - formulas sem preco', v_msg, 'pendente_notificacao');
    ELSE
      -- Codex [P1]: com ON CONFLICT DO NOTHING, um SEGUNDO corante caindo durante um
      -- incidente aberto ficaria MUDO. Se o conjunto PIOROU, atualiza e re-emite.
      SELECT COALESCE((contexto->>'corantes')::int, 0) INTO v_ant_n
        FROM fin_alertas
       WHERE company = v_conta AND tipo = 'tint_corante_impagavel' AND dismissed_at IS NULL;

      IF v_ruins > COALESCE(v_ant_n, 0) THEN
        UPDATE fin_alertas
           SET severidade = v_sev_fin, mensagem = v_msg,
               contexto = jsonb_build_object('corantes', v_ruins, 'formulas_ativas', v_formulas,
                                             'detalhe', v_lista, 'avaliado_em', now(),
                                             'agravou_de', v_ant_n)
         WHERE company = v_conta AND tipo = 'tint_corante_impagavel' AND dismissed_at IS NULL;

        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (v_conta, 'outro', v_sev_forn,
                '[Tintometrico] AGRAVOU: ' || v_ruins || ' corantes sem custo',
                v_msg || E'\n\n(agravamento: eram ' || v_ant_n || ')', 'pendente_notificacao');
      END IF;
    END IF;
  ELSE
    UPDATE fin_alertas SET dismissed_at = now()
     WHERE company = v_conta AND tipo = 'tint_corante_impagavel' AND dismissed_at IS NULL;
  END IF;

  -- ── MARCADOR DE SUCESSO (Codex [P1]: "verde por construção") ────────────
  -- last_sync_at = último sucesso COMPLETO. Só chega aqui quem avaliou e transicionou
  -- o alerta; qualquer exceção acima aborta a função e NAO avança o marcador - então
  -- "sem alerta" deixa de ser indistinguível de "nunca rodou".
  INSERT INTO sync_state (entity_type, account, last_sync_at, status, error_message, metadata)
  VALUES ('tint_watchdog_corante', v_conta, now(), 'complete', NULL,
          jsonb_build_object('corantes_ruins', v_ruins, 'formulas_atingidas', v_formulas))
  ON CONFLICT (entity_type, account) DO UPDATE
    SET last_sync_at  = now(),
        status        = 'complete',
        error_message = NULL,
        updated_at    = now(),
        metadata      = jsonb_build_object('corantes_ruins', v_ruins,
                                           'formulas_atingidas', v_formulas);

  -- ── VIGILÂNCIA CRUZADA (dead-man da Camada B, quando ela existir) ───────
  -- Um cron não vigia a si mesmo: cron.job_run_details diz "succeeded" só por ter
  -- ENFILEIRADO. Como esta camada roda */5 e é barata, ela vigia o marcador da
  -- camada lenta (6h). O caso "pg_cron inteiro morreu" já é coberto pelo
  -- dead-man-switch global existente (fin_sync_heartbeat para de enviar).
  -- Só age se o marcador da B JA existir (ela é o PR 2), senão esta função
  -- alarmaria por ausência de algo que ainda não foi entregue.
  SELECT now() - ss.last_sync_at INTO v_b_atraso
    FROM sync_state ss
   WHERE ss.entity_type = 'tint_watchdog_fase5' AND ss.account = v_conta;

  IF v_b_atraso IS NOT NULL AND v_b_atraso > interval '13 hours' THEN
    -- 13h = 2 ciclos de 6h + folga (Codex: "dead-man da B dispara após 2 ciclos perdidos")
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
    VALUES (v_conta, 'tint_watchdog_fase5_parado', 'aviso',
            'Watchdog da Fase 5 (chave sem preco) sem sucesso ha ' ||
            date_trunc('minute', v_b_atraso) || ' - a rede de deteccao por chave esta CEGA.',
            jsonb_build_object('atraso', v_b_atraso::text))
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (v_conta, 'outro', 'atencao', '[Tintometrico] watchdog da Fase 5 parado',
              'O watchdog por chave nao conclui ha ' || date_trunc('minute', v_b_atraso) ||
              '. Cheque o cron tint-watchdog-fase5-6h.', 'pendente_notificacao');
    END IF;
  ELSIF v_b_atraso IS NOT NULL THEN
    UPDATE fin_alertas SET dismissed_at = now()
     WHERE company = v_conta AND tipo = 'tint_watchdog_fase5_parado' AND dismissed_at IS NULL;
  END IF;
END;
$function$;

-- CREATE OR REPLACE preserva o ACL (REVOKE da 20260730120000); reemitido por nome mesmo
-- assim (idempotente) e re-conferido na postcondição.
REVOKE EXECUTE ON FUNCTION public.tint_watchdog_corante_check()
  FROM PUBLIC, anon, authenticated;

-- Postcondição: v3 gravada, plano custom, índice presente, SECURITY DEFINER e superfície fechada.
DO $post$
DECLARE f constant text := 'public.tint_watchdog_corante_check()';
BEGIN
  IF position('tint_watchdog_corante guard v3' IN
              (SELECT prosrc FROM pg_proc WHERE oid = f::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'postcondicao: marcador guard v3 ausente de %', f;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS cfg
                  WHERE p.oid = f::regprocedure
                    AND cfg = 'plan_cache_mode=force_custom_plan') THEN
    RAISE EXCEPTION 'postcondicao: % sem plan_cache_mode=force_custom_plan', f;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon/authenticated executam %', f;
  END IF;
  -- IF NOT EXISTS só olha o NOME: confere que é o índice certo e utilizável (Codex P2).
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.idx_tint_formula_itens_corante')
       AND i.indrelid   = 'public.tint_formula_itens'::regclass
       AND i.indisvalid AND i.indisready
       AND i.indpred IS NULL
       AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a
                           WHERE a.attrelid = 'public.tint_formula_itens'::regclass
                             AND a.attname = 'corante_id')) THEN
    RAISE EXCEPTION 'postcondicao: idx_tint_formula_itens_corante ausente, invalido ou nao lidera por corante_id';
  END IF;
  RAISE NOTICE 'TINT-WATCHDOG-CORANTE-V3-OK';
END
$post$;

COMMIT;
