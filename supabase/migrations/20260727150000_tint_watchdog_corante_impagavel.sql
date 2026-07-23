-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — WATCHDOG da causa-raiz: corante impagável EM USO
-- (Fase 5b#2, PR 1 de 2 — spec docs/superpowers/specs/2026-07-22-tint-fase5-watchdog-design.md)
--
-- POR QUE EXISTE. A Fase 5 (20260727120000) desativou 463.995 fórmulas da geração
-- '1' porque cada chave tinha gêmea SL ATIVA E VÁLIDA. Os guards provaram isso NO
-- INSTANTE DO APPLY — mas a propriedade NÃO É DURÁVEL: se a SL invalidar depois, a
-- '1' que a respaldava já está desativada, a chave fica sem fórmula precificável
-- (RPC devolve precoFinal=NULL, fail-closed), o balcão não vende, e ninguém é
-- avisado. É o P1-7 do challenge Codex da Fase 5, calibrado à época como 5b.
--
-- O QUE ESTA MIGRATION VIGIA (e por que este recorte). Medido em prod 2026-07-23:
-- existem só 14 CORANTES, e o mais usado está em 296.931 fórmulas ativas.
-- => o modo de falha dominante NAO é uma chave degradar: é UM corante perder custo
-- Omie (ou ficar inativo) e invalidar centenas de milhares de fórmulas DE UMA VEZ.
-- Como a Fase 5 removeu o fallback, isso derruba a venda de boa parte do catálogo
-- simultaneamente. A causa-raiz é observável em 14 linhas: 214ms, contra 26s da
-- varredura por chave — daí a cadência */5 (a Camada B, por chave, é o PR 2).
--
-- NAO vive no _data_health_compute, e não é só preferência: authenticated tem
-- statement_timeout=8s e o dashboard /health chama get_data_health() -> o compute
-- (useDataHealth.ts:21, repetido pelo DataHealthBadge). SECURITY DEFINER troca
-- privilégio, NAO o statement_timeout. Um check pesado ali derruba o dashboard
-- inteiro. Este cron roda como supabase_admin (statement_timeout=0). Bônus: não
-- toca o arquivo mais quente do repo (45k chars, 5 reversões por cascata).
--
-- ESTE WATCHDOG NAO DEPENDE DO CARIMBO da Fase 5 — de propósito. O tombstone
-- não é fundamento durável (linha deletada / motivo limpo => o universo some =>
-- o resultado vira zero => "verde"). Ancorar na FONTE do dano (o corante) é imune
-- a isso, e ainda cobre chaves que nunca tiveram a geração '1'.
--
-- ── Achados do challenge Codex (gpt-5.6-sol, 2026-07-22) endereçados aqui ──
--  [P0] "diária deixa a avalanche invisível por 24h"  -> */5 (214ms permite).
--  [P1] "A e B no mesmo job = dependência de falha"    -> função e cron PRÓPRIOS.
--  [P1] "sem last_success_at, ausência de alerta não é saúde; verde por
--       construção"                                    -> marcador em sync_state,
--       que só avança em avaliação COMPLETA. Erro NAO avança e NAO dismissa.
--  [P1] "ON CONFLICT DO NOTHING esconde um 2o corante que caia durante um
--       incidente aberto"                              -> quando o conjunto PIORA,
--       o alerta ativo é ATUALIZADO e o e-mail RE-ENFILEIRADO (não fica mudo).
--  [P2] "falta política de agravamento"                -> severidade escala pelo
--       no. de fórmulas ativas atingidas.
--
-- Prova: db/test-tint-watchdog-corante.sh (PG17, migration REAL, falsificação).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- tint_watchdog_corante guard v1 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v2, v3...), para que
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
  -- Corante cujo custo Omie não precifica, E que está EM USO por fórmula ativa.
  -- O predicado espelha corantes_completos da RPC get_tint_price / receita_valida
  -- da v_tint_formula_canonica: valor_unitario>0 E omie ativo E volume_total_ml>0.
  -- O filtro de USO evita alarmar por corante recém-cadastrado que ninguém dosa.
  SELECT count(*),
         COALESCE(sum(x.formulas), 0),
         string_agg(x.rotulo, '; ' ORDER BY x.formulas DESC)
    INTO v_ruins, v_formulas, v_lista
  FROM (
    SELECT c.id,
           (SELECT count(*) FROM tint_formula_itens fi
              JOIN tint_formulas f ON f.id = fi.formula_id
             WHERE fi.corante_id = c.id
               AND f.desativada_em IS NULL AND f.sku_id IS NOT NULL) AS formulas,
           COALESCE(NULLIF(btrim(op.descricao), ''), op.codigo, c.id::text)
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
       AND EXISTS (SELECT 1 FROM tint_formula_itens fi
                     JOIN tint_formulas f ON f.id = fi.formula_id
                    WHERE fi.corante_id = c.id
                      AND f.desativada_em IS NULL AND f.sku_id IS NOT NULL)
  ) x;

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

COMMENT ON FUNCTION public.tint_watchdog_corante_check() IS
  'Fase 5b#2 (PR 1): vigia a CAUSA-RAIZ do P1-7 - corante sem custo Omie utilizavel '
  'que esta EM USO por formula ativa. Com 14 corantes e o maior deles em ~297k '
  'formulas, um corante caindo tira o preco de centenas de milhares de chaves de uma '
  'vez, e a Fase 5 removeu o fallback da geracao 1. Roda */5 (214ms). NAO depende '
  'do carimbo fase5_geracao_legada (tombstone nao e fundamento duravel). Grava '
  'marcador sync_state tint_watchdog_corante que so avanca em sucesso COMPLETO. '
  'NAO pode migrar para _data_health_compute: authenticated tem statement_timeout=8s '
  'e o dashboard /health chama aquele caminho.';

-- Cron SQL-local (roda no Postgres como supabase_admin => statement_timeout=0).
-- NAO usa net.http_post, então não precisa de timeout_milliseconds; e o
-- job_run_details aqui carrega o erro plpgsql REAL (cron SQL-local é fonte
-- primária confiável - docs/agent/sync.md).
-- cron.schedule faz upsert por nome => idempotente.
SELECT cron.schedule(
  'tint-watchdog-corante-5min',
  '*/5 * * * *',
  $cron$SELECT public.tint_watchdog_corante_check();$cron$
);

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO PÓS-APPLY (read-only; o founder cola, ou eu rodo via psql-ro)
--   1) a função existe e o cron está armado:
--      SELECT to_regprocedure('public.tint_watchdog_corante_check()') IS NOT NULL AS fn_ok,
--             (SELECT active FROM cron.job WHERE jobname='tint-watchdog-corante-5min') AS cron_ativo;
--   2) primeira execução manual + marcador (esperado: corantes_ruins=0 em 2026-07-23):
--      SELECT public.tint_watchdog_corante_check();
--      SELECT status, last_sync_at, metadata FROM public.sync_state
--       WHERE entity_type='tint_watchdog_corante' AND account='oben';
--   3) nasce VERDE (nenhum alerta aberto por ele):
--      SELECT count(*) FROM public.fin_alertas
--       WHERE tipo IN ('tint_corante_impagavel','tint_watchdog_fase5_parado')
--         AND dismissed_at IS NULL;   -- esperado 0
-- ───────────────────────────────────────────────────────────────────────────
