-- ============================================================================================
-- Recompute ÚNICO do DRE que ficou sem escritor (2026-10-18)  [money-path]
--
-- Par da migration 20261019090100_fin_dre_recalculo_diario_cron.sql: o cron cobre mês anterior +
-- corrente daqui para frente; este arquivo preenche o buraco que já existe. Não é migration (um DR
-- não deve repetir um backfill datado).
--
-- O QUE: enfileira chamadas à edge `omie-financeiro` `calcular_dre` (a mesma rota do botão):
--   · competência, abr–out/2026, Oben e Colacor SC (ambas paradas em 2026-03) — 1 chamada por empresa
--     (competência custa ~0,2 s/mês);
--   · caixa, abr–out/2026, Oben (só tinha abril, de 30/05) — 1 chamada por mês (~30 s/mês cada).
-- O CMV sai do cálculo da edge sobre os títulos sincronizados; nada é estimado aqui.
--
-- Idempotente: a edge faz upsert (company,ano,mes,regime) — rodar de novo só recalcula.
-- Há 0 linhas em fin_fechamentos (conferido por psql-ro em 2026-10-18): nenhum mês fechado é tocado.
--
-- APLICAR: bun run db:aplicar db/recalculo-fin-dre-oben-colacor-sc-2026-04-a-10.sql
-- VALIDAR (psql-ro, ~5 min depois): net._http_response dos ids do NOTICE = 200; 12 meses competência
--   fechados da Oben até 2026-09 com calculated_at de hoje.
-- ============================================================================================

DO $recalculo$
DECLARE
  c text;
  m int;
  v_ids bigint[] := '{}';
  v_hdr jsonb := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1));
BEGIN
  IF v_hdr ->> 'x-cron-secret' IS NULL THEN
    RAISE EXCEPTION 'R0 FALHOU: CRON_SECRET ausente no vault — nenhuma chamada enfileirada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fin_fechamentos
              WHERE company IN ('oben', 'colacor_sc') AND ano = 2026 AND mes BETWEEN 4 AND 10) THEN
    RAISE EXCEPTION 'R1 FALHOU: há fechamento em abr–out/2026 da Oben/Colacor SC — recompute exige decisão';
  END IF;

  FOREACH c IN ARRAY ARRAY['oben', 'colacor_sc'] LOOP
    v_ids := v_ids || net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
      headers := v_hdr,
      body := jsonb_build_object('action', 'calcular_dre', 'company', c, 'ano', 2026,
                                 'meses', jsonb_build_array(4, 5, 6, 7, 8, 9, 10), 'regime', 'competencia'),
      timeout_milliseconds := 150000);
  END LOOP;

  FOR m IN 4..10 LOOP
    v_ids := v_ids || net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
      headers := v_hdr,
      body := jsonb_build_object('action', 'calcular_dre', 'company', 'oben', 'ano', 2026,
                                 'meses', jsonb_build_array(m), 'regime', 'caixa'),
      timeout_milliseconds := 150000);
  END LOOP;

  -- Postcondição: as 9 requisições DESTA execução estão na fila (o pg_net só dispara após o COMMIT).
  -- O resultado HTTP de cada id confere-se depois em net._http_response (psql-ro); o NOTICE leva os ids.
  IF cardinality(v_ids) IS DISTINCT FROM 9 OR (SELECT count(*) FROM net.http_request_queue q WHERE q.id = ANY (v_ids)) IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'R2 FALHOU: % ids capturados, esperado 9 na fila do pg_net', cardinality(v_ids);
  END IF;
  RAISE NOTICE 'recompute enfileirado, ids pg_net: %', v_ids;
END
$recalculo$;
