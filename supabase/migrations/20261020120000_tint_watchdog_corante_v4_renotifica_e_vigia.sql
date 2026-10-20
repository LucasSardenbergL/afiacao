-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — WATCHDOG de corante impagável, v4 (sucede a 20261019160000)
--
-- Fecha as DUAS pendências deixadas pelo incidente de 2026-10-19 (PR #3196):
--
-- 1) RE-NOTIFICAÇÃO POR IDENTIDADE (Codex P1 herdado da v1). As v1-v3 só re-emitiam o
--    e-mail quando a QUANTIDADE de corantes ruins subia (v_ruins > anterior). Ficavam MUDOS:
--    trocar um corante por outro (1 -> 1), 2 -> 1 -> 2, e o MESMO corante se espalhar até
--    >= 1000 fórmulas ('critico' calculado e nunca persistido). O contexto agora guarda os
--    ids atuais e 'vistos' (união de todos os ids do incidente); re-emite se entrou corante
--    NUNCA VISTO no incidente ou a severidade subiu a 'critico'; qualquer outra mudança só
--    atualiza o alerta (que deixa de descrever estado velho), sem e-mail. Histerese (Codex
--    P2): a severidade é PEGAJOSA durante o incidente — 999<->1000 fórmulas ou um corante
--    que sai e volta não re-emitem a cada oscilação.
--
-- 2) VIGIA DA CAMADA A. Em 2026-10-19 a A estourou statement timeout 43 vezes (~11h) e
--    NINGUÉM viu: timeout aborta antes do marcador, sync_state fica 'complete' e só
--    envelhece; o sync_state_saude do data_health olha status='error'; a A vigiava a B,
--    não o contrário. Nova tint_watchdog_corante_vigia_check (*/15, lê 1 linha): marcador da
--    A > 30 min -> alerta. E a A passa a vigiar o marcador da vigia (> 1h) — nenhum cron
--    vigia a si mesmo. A migration EXECUTA a vigia uma vez e exige o marcador dela (Codex P1:
--    vigia que nunca estreia não deixa marcador e a A ignoraria a ausência para sempre).
--    Fora do _data_health_compute de propósito (arquivo mais quente do
--    repo; statement_timeout 8s do /health).
--
-- O resto da A é a v3 byte a byte (detecção com candidatos + force_custom_plan, marcador,
-- dead-man da Camada B). Prova: db/test-tint-watchdog-corante.sh (PG17, v1->v2->v3->v4).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '10s';

-- TRAVA antes de ler (ALTER sem efeito: a função já é VOLATILE) — ninguém troca a função
-- entre a PRE e o CREATE.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_watchdog_corante_check()') IS NOT NULL THEN
    ALTER FUNCTION public.tint_watchdog_corante_check() VOLATILE;
  END IF;
  IF to_regprocedure('public.tint_watchdog_corante_vigia_check()') IS NOT NULL THEN
    ALTER FUNCTION public.tint_watchdog_corante_vigia_check() VOLATILE;
  END IF;
END
$trava$;

-- PRE anti-deriva: md5 do corpo vivo ∈ {v3 aplicada em prod 2026-10-19, esta v4}. Outro ABORTA.
-- A vigia é nova: ausente, ou já esta versão (re-aplicação).
DO $pre$
DECLARE
  vivo  text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure('public.tint_watchdog_corante_check()'));
  vigia text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure('public.tint_watchdog_corante_vigia_check()'));
BEGIN
  IF vivo IS NULL OR vivo NOT IN ('eeddd88a26585696edfd88fc270570ce', '871204cf566111fb170c4b385ce10f87') THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_corante_check() vivo (md5 %) nao e a v3 aplicada nem esta v4', vivo;
  END IF;
  IF vigia IS NOT NULL AND vigia <> 'cf128aad0db39281833350bc03872859' THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_corante_vigia_check() existe com corpo desconhecido (md5 %)', vigia;
  END IF;
  IF to_regclass('public.idx_tint_formula_itens_corante') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: idx_tint_formula_itens_corante ausente (aplique a v2)';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  -- tint_watchdog_corante guard v4 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v5, v6...), para que
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
  v_ant_ids      uuid[];
  v_ant_vistos   uuid[];
  v_vistos       uuid[];
  v_ant_sev      text;
  v_ant_formulas bigint;
  v_novos        uuid[];
  v_escalou      boolean;
  v_contexto     jsonb;
  v_b_atraso     interval;
  v_vigia_atraso interval;
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
         array_agg(c.id ORDER BY c.id),
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
    -- v4: o contexto guarda a IDENTIDADE do conjunto (ids ordenados) e 'vistos' (união dos
    -- ids do incidente inteiro), não só a quantidade.
    v_contexto := jsonb_build_object('corantes', v_ruins, 'formulas_ativas', v_formulas,
                                     'ids', to_jsonb(v_ids), 'vistos', to_jsonb(v_ids),
                                     'detalhe', v_lista, 'avaliado_em', now());

    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
    VALUES (v_conta, 'tint_corante_impagavel', v_sev_fin, v_msg, v_contexto)
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;

    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (v_conta, 'outro', v_sev_forn,
              '[Tintometrico] corante sem custo - formulas sem preco', v_msg, 'pendente_notificacao');
    ELSE
      -- Incidente ABERTO. v4 (pendência herdada da v1, achada pelo Codex 2026-10-19): a v1-v3
      -- só re-emitiam quando a QUANTIDADE subia — trocar um corante por outro, ou o mesmo
      -- corante se espalhar até 'critico', ficava MUDO e o alerta descrevia o estado velho.
      -- Agora: re-emite se entrou corante NUNCA VISTO no incidente OU a severidade subiu a
      -- 'critico'; qualquer outra mudança (conjunto encolheu, nº de fórmulas mudou) só
      -- ATUALIZA, calado. Histerese: severidade pegajosa + 'vistos' (sem e-mail por oscilação).
      SELECT COALESCE((contexto->>'corantes')::int, 0),
             CASE WHEN jsonb_typeof(contexto->'ids') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(contexto->'ids')::uuid ORDER BY 1)
             END,
             CASE WHEN jsonb_typeof(contexto->'vistos') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(contexto->'vistos')::uuid ORDER BY 1)
             END,
             severidade,
             (contexto->>'formulas_ativas')::bigint
        INTO v_ant_n, v_ant_ids, v_ant_vistos, v_ant_sev, v_ant_formulas
        FROM fin_alertas
       WHERE company = v_conta AND tipo = 'tint_corante_impagavel' AND dismissed_at IS NULL;

      v_ant_vistos := COALESCE(v_ant_vistos, v_ant_ids);
      IF v_ant_vistos IS NULL THEN
        -- alerta aberto por versão anterior (sem 'ids'): só a quantidade é comparável
        v_novos := CASE WHEN v_ruins > COALESCE(v_ant_n, 0) THEN v_ids END;
      ELSE
        v_novos := ARRAY(SELECT x FROM unnest(v_ids) x WHERE x <> ALL (v_ant_vistos) ORDER BY 1);
      END IF;
      v_vistos := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(v_ant_vistos, '{}') || v_ids) x ORDER BY 1);
      v_escalou := v_sev_fin = 'critico' AND v_ant_sev IS DISTINCT FROM 'critico';
      -- severidade PEGAJOSA: o incidente guarda o pior estado até fechar (dismiss)
      IF v_ant_sev = 'critico' THEN
        v_sev_fin := 'critico';
      END IF;
      v_contexto := v_contexto || jsonb_build_object('vistos', to_jsonb(v_vistos));

      IF COALESCE(cardinality(v_novos), 0) > 0 OR v_escalou THEN
        UPDATE fin_alertas
           SET severidade = v_sev_fin, mensagem = v_msg,
               contexto = v_contexto || jsonb_build_object('agravou_de', v_ant_n)
         WHERE company = v_conta AND tipo = 'tint_corante_impagavel' AND dismissed_at IS NULL;

        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (v_conta, 'outro', v_sev_forn,
                '[Tintometrico] AGRAVOU: ' || v_ruins || ' corantes sem custo',
                v_msg || E'\n\n(agravamento: eram ' || v_ant_n || ' corante(s)'
                      || CASE WHEN COALESCE(cardinality(v_novos), 0) > 0
                              THEN '; ' || cardinality(v_novos) || ' novo(s) no conjunto' ELSE '' END
                      || CASE WHEN v_escalou THEN '; passou a critico' ELSE '' END || ')',
                'pendente_notificacao');
      ELSIF v_ant_ids IS DISTINCT FROM v_ids
         OR v_ant_formulas IS DISTINCT FROM v_formulas
         OR v_ant_vistos IS DISTINCT FROM v_vistos THEN
        UPDATE fin_alertas
           SET severidade = v_sev_fin, mensagem = v_msg, contexto = v_contexto
         WHERE company = v_conta AND tipo = 'tint_corante_impagavel' AND dismissed_at IS NULL;
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

  -- ── VIGILÂNCIA CRUZADA da VIGIA (v4) ────────────────────────────────────
  -- A vigia (tint_watchdog_corante_vigia_check, */15) vigia o marcador DESTA função; esta
  -- vigia o dela — nenhum cron vigia a si mesmo. 1h = 4 ciclos perdidos. Só age se o
  -- marcador da vigia JA existir (mesma regra do dead-man da Camada B).
  SELECT now() - ss.last_sync_at INTO v_vigia_atraso
    FROM sync_state ss
   WHERE ss.entity_type = 'tint_watchdog_corante_vigia' AND ss.account = v_conta;

  IF v_vigia_atraso IS NOT NULL AND v_vigia_atraso > interval '1 hour' THEN
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
    VALUES (v_conta, 'tint_watchdog_corante_vigia_parada', 'aviso',
            'Vigia do watchdog de corante sem sucesso ha ' || date_trunc('minute', v_vigia_atraso)
            || ' - se o watchdog de corante morrer, ninguem avisa.',
            jsonb_build_object('atraso', v_vigia_atraso::text))
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (v_conta, 'outro', 'atencao', '[Tintometrico] vigia do watchdog de corante parada',
              'A vigia nao conclui ha ' || date_trunc('minute', v_vigia_atraso) ||
              '. Cheque o cron tint-watchdog-corante-vigia-15min.', 'pendente_notificacao');
    END IF;
  ELSIF v_vigia_atraso IS NOT NULL THEN
    UPDATE fin_alertas SET dismissed_at = now()
     WHERE company = v_conta AND tipo = 'tint_watchdog_corante_vigia_parada' AND dismissed_at IS NULL;
  END IF;
END;
$function$;

-- ── VIGIA da Camada A (v4) ────────────────────────────────────────────────
-- Incidente 2026-10-19: o watchdog de corante estourou statement timeout 43 vezes seguidas
-- (~11h). O timeout aborta a função ANTES do marcador, então sync_state ficou 'complete' e só
-- ENVELHECEU — o sensor sync_state_saude do data_health olha status='error' e não viu; e ninguém
-- vigiava a idade do marcador (a Camada A vigiava a B, não o contrário). Esta função é mínima
-- de propósito (lê 1 linha): não compartilha o modo de falha da A (custo da detecção).
CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_vigia_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $vigia$
DECLARE
  -- tint_watchdog_corante_vigia v1
  v_conta   text := 'oben';
  v_atraso  interval;
BEGIN
  SELECT now() - ss.last_sync_at INTO v_atraso
    FROM sync_state ss
   WHERE ss.entity_type = 'tint_watchdog_corante' AND ss.account = v_conta;

  -- 30 min = 6 ciclos de */5 perdidos. Marcador AUSENTE também é parada (a A sempre o grava).
  IF v_atraso IS NULL OR v_atraso > interval '30 minutes' THEN
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
    VALUES (v_conta, 'tint_watchdog_corante_parado', 'aviso',
            'Watchdog de corante (tint-watchdog-corante-5min) sem sucesso ha '
            || COALESCE(date_trunc('minute', v_atraso)::text, 'sempre (marcador ausente)')
            || ' - corante sem custo derrubando preco do balcao NAO seria detectado.',
            jsonb_build_object('atraso', v_atraso::text))
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (v_conta, 'outro', 'atencao', '[Tintometrico] watchdog de corante parado',
              'O watchdog de corante nao conclui ha '
              || COALESCE(date_trunc('minute', v_atraso)::text, 'sempre')
              || '. Cheque cron.job_run_details do job tint-watchdog-corante-5min (timeout?).',
              'pendente_notificacao');
    END IF;
  ELSE
    UPDATE fin_alertas SET dismissed_at = now()
     WHERE company = v_conta AND tipo = 'tint_watchdog_corante_parado' AND dismissed_at IS NULL;
  END IF;

  -- marcador da vigia (a Camada A o vigia: >1h parado -> alerta)
  INSERT INTO sync_state (entity_type, account, last_sync_at, status, error_message, metadata)
  VALUES ('tint_watchdog_corante_vigia', v_conta, now(), 'complete', NULL,
          jsonb_build_object('atraso_a', v_atraso::text))
  ON CONFLICT (entity_type, account) DO UPDATE
    SET last_sync_at = now(), status = 'complete', error_message = NULL, updated_at = now(),
        metadata = jsonb_build_object('atraso_a', v_atraso::text);
END;
$vigia$;

REVOKE EXECUTE ON FUNCTION public.tint_watchdog_corante_vigia_check()
  FROM PUBLIC, anon, authenticated;

-- Cron SQL-local (supabase_admin/postgres => sem statement_timeout curto; não usa net.http_post).
-- cron.schedule faz upsert por nome => idempotente.
SELECT cron.schedule('tint-watchdog-corante-vigia-15min', '*/15 * * * *',
                     'SELECT public.tint_watchdog_corante_vigia_check()');

-- Estreia (Codex P1): grava o 1º marcador da vigia AGORA. Sem isso, se o cron nunca rodar,
-- não há marcador e a A ignora a ausência para sempre. Com a A saudável, não alerta nada.
SELECT public.tint_watchdog_corante_vigia_check();

-- CREATE OR REPLACE preserva o ACL (REVOKE da 20260730120000); reemitido por nome mesmo
-- assim (idempotente) e re-conferido na postcondição.
REVOKE EXECUTE ON FUNCTION public.tint_watchdog_corante_check()
  FROM PUBLIC, anon, authenticated;

-- Postcondição: v4 gravada, vigia + cron armados, plano custom, índice presente, SECURITY DEFINER e superfície fechada.
DO $post$
DECLARE f constant text := 'public.tint_watchdog_corante_check()';
BEGIN
  IF position('tint_watchdog_corante guard v4' IN
              (SELECT prosrc FROM pg_proc WHERE oid = f::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'postcondicao: marcador guard v4 ausente de %', f;
  END IF;
  IF to_regprocedure('public.tint_watchdog_corante_vigia_check()') IS NULL
     OR has_function_privilege('anon', 'public.tint_watchdog_corante_vigia_check()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_watchdog_corante_vigia_check()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: vigia ausente ou exposta a anon/authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'tint-watchdog-corante-vigia-15min'
                    AND schedule = '*/15 * * * *'
                    AND command = 'SELECT public.tint_watchdog_corante_vigia_check()'
                    AND active) THEN
    RAISE EXCEPTION 'postcondicao: cron tint-watchdog-corante-vigia-15min ausente/inativo/diferente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-watchdog-corante-5min' AND active) THEN
    RAISE EXCEPTION 'postcondicao: cron da Camada A (tint-watchdog-corante-5min) ausente/inativo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sync_state
                  WHERE entity_type = 'tint_watchdog_corante_vigia' AND account = 'oben'
                    AND last_sync_at > now() - interval '5 minutes') THEN
    RAISE EXCEPTION 'postcondicao: a vigia nao estreou (marcador ausente)';
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
  RAISE NOTICE 'TINT-WATCHDOG-CORANTE-V4-OK';
END
$post$;

COMMIT;
