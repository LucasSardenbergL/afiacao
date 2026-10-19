-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — WATCHDOG de corante impagável, v2 (sucede a 20260727150000)
--
-- INCIDENTE 2026-10-19 (medido em prod por psql-ro):
--   ~10:28 UTC o sync trouxe uma linha NOVA da Sayerlack, "ACAB10 PU 6506A CORES": 12 corantes
--   novos (WFO.6506.xx, sem produto no Omie) em 28 fórmulas novas, cujo SKU base (tint_skus)
--   TAMBÉM não tem vínculo Omie. A Oben não vende essa linha (founder, 2026-10-19).
--   Dois defeitos apareceram juntos:
--   (1) RUÍDO: o alerta "11 corante(s) sem custo ... 148 formula(s)" culpou o corante, mas
--       essas fórmulas nunca tiveram preço — a BASE delas já não precifica. Nenhuma fórmula
--       vendável perdeu preço. E o e-mail listou UUIDs: o rótulo caía em c.id quando não havia
--       produto Omie, ignorando tint_corantes.descricao (NOT NULL).
--   (2) CEGUEIRA: o detector fazia, POR corante ruim, um count(*) e um EXISTS correlacionados
--       sobre tint_formula_itens (3,5M linhas) SEM índice em corante_id => 2 varreduras
--       completas por corante. Com 0 corantes ruins custava 0s; com 12, estourou o timeout:
--       cron tint-watchdog-corante-5min com 43 'failed' (statement timeout, 120s) desde 10h
--       UTC, marcador sync_state 'tint_watchdog_corante' parado. O vigia morreu justamente
--       quando havia o que vigiar.
--
-- MUDANÇAS (o resto da função é a v1 byte a byte: transições do alerta, agravamento,
-- marcador de sucesso, dead-man cruzado da Camada B):
--   a) Uma fórmula só conta se a BASE dela precifica — o MESMO predicado de base da RPC
--      get_tint_price (v_base_disponivel): omie_products do tint_skus.omie_product_id com
--      valor_unitario > 0 E ativo. Se a base não precifica, a fórmula já está sem preço por
--      outro motivo e o corante não é o bloqueio (precisão > recall; f.sku_id IS NOT NULL
--      da v1 fica implícito no JOIN).
--   b) Rótulo: descrição Omie -> código Omie -> descrição do corante -> id.
--   c) Uma única avaliação por corante ruim (LATERAL count, filtro > 0) no lugar de
--      count + EXISTS, e índice em tint_formula_itens(corante_id): cada corante ruim vira
--      um index scan em vez de uma varredura de 3,5M linhas.
--
-- ⚠️ O CREATE INDEX (não-CONCURRENTLY: dentro da transação) segura SHARE LOCK em
-- tint_formula_itens durante o build — LEITURA segue livre (balcão/RPC), ESCRITA (promote do
-- sync) espera. Aplicar fora de uma promoção em curso (tint_sync_runs sem 'running').
--
-- Prova: db/test-tint-watchdog-corante.sh (PG17, aplica a v1 e ESTA por cima, falsificação).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- TRAVA antes de ler (ALTER sem efeito: a função já é VOLATILE) — ninguém troca a função
-- entre a PRE e o CREATE.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_watchdog_corante_check()') IS NOT NULL THEN
    ALTER FUNCTION public.tint_watchdog_corante_check() VOLATILE;
  END IF;
END
$trava$;

-- PRE anti-deriva: md5 do corpo vivo ∈ {v1 medida em prod 2026-10-19, esta v2}. Outro ABORTA.
DO $pre$
DECLARE vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                       WHERE p.oid = to_regprocedure('public.tint_watchdog_corante_check()'));
BEGIN
  IF vivo IS NULL OR vivo NOT IN ('c512a912fb1725fb89413ddc6690fde3', '78ed0866d39c4268a5773d3bb2399b1c') THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_corante_check() vivo (md5 %) nao e a v1 revisada nem esta v2', vivo;
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
AS $function$
DECLARE
  -- tint_watchdog_corante guard v2 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v3, v4...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  v_conta        text := 'oben';   -- 100% do catálogo tint é oben (medido)
  v_ruins        int;
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
  -- Uma avaliação por corante ruim, via idx_tint_formula_itens_corante (v2: a v1 fazia
  -- count + EXISTS sem índice e estourou o timeout com 12 corantes ruins).
  SELECT count(*),
         COALESCE(sum(u.formulas), 0),
         string_agg(r.rotulo, '; ' ORDER BY u.formulas DESC)
    INTO v_ruins, v_formulas, v_lista
  FROM (
    SELECT c.id,
           COALESCE(NULLIF(btrim(op.descricao), ''), op.codigo,
                    NULLIF(btrim(c.descricao), ''), c.id::text)
             || ' (' || CASE
                  WHEN c.omie_product_id IS NULL              THEN 'sem vinculo Omie'
                  WHEN op.id IS NULL                          THEN 'produto Omie inexistente'
                  WHEN NOT COALESCE(op.ativo, false)          THEN 'inativo no Omie'
                  WHEN COALESCE(op.valor_unitario, 0) <= 0    THEN 'sem custo'
                  ELSE 'volume_total_ml invalido' END || ')' AS rotulo
      FROM tint_corantes c
      LEFT JOIN omie_products op ON op.id = c.omie_product_id
     WHERE NOT (COALESCE(op.valor_unitario, 0) > 0
                AND COALESCE(op.ativo, false)
                AND c.volume_total_ml IS NOT NULL
                AND c.volume_total_ml > 0)
  ) r
  CROSS JOIN LATERAL (
    SELECT count(*) AS formulas
      FROM tint_formula_itens fi
      JOIN tint_formulas f    ON f.id = fi.formula_id
      JOIN tint_skus s        ON s.id = f.sku_id
      JOIN omie_products bp   ON bp.id = s.omie_product_id
     WHERE fi.corante_id = r.id
       AND f.desativada_em IS NULL
       AND bp.valor_unitario > 0 AND COALESCE(bp.ativo, false)
  ) u
  WHERE u.formulas > 0;

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

-- Postcondição: v2 gravada, índice presente, SECURITY DEFINER e superfície fechada.
DO $post$
DECLARE f constant text := 'public.tint_watchdog_corante_check()';
BEGIN
  IF position('tint_watchdog_corante guard v2' IN
              (SELECT prosrc FROM pg_proc WHERE oid = f::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'postcondicao: marcador guard v2 ausente de %', f;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon/authenticated executam %', f;
  END IF;
  IF to_regclass('public.idx_tint_formula_itens_corante') IS NULL THEN
    RAISE EXCEPTION 'postcondicao: idx_tint_formula_itens_corante ausente';
  END IF;
  RAISE NOTICE 'TINT-WATCHDOG-CORANTE-V2-OK';
END
$post$;

COMMIT;
