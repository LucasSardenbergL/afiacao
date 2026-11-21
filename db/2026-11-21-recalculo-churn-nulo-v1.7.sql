-- ============================================================================================
-- Recálculo forçado do calculate-scores v1.7 (churn_risk NULL p/ sem_historico, #4060) [money-path]
--
-- O QUE: executa AGORA o comando do próprio job `daily-calculate-scores`, lido de cron.job (mesmo
-- escopo e credencial do cron — o segredo fica no vault, nunca neste arquivo). O run das 06:00 UTC
-- de hoje rodou ANTES do deploy da v1.7, então os 15.766 sem_historico ainda carregam o 100 antigo.
--
-- Idempotente: a edge regrava os scores; rodar de novo só recalcula. Lease ocupado → skipped:true
-- (200, sem efeito) — conferir a resposta.
--
-- APLICAR: bun run db:aplicar db/2026-11-21-recalculo-churn-nulo-v1.7.sql
-- VALIDAR (psql-ro, alguns min depois): net._http_response do id do NOTICE = 200, versão v1.7 e
--   não skipped; sem_historico com churn preenchido = 0; ativo/stale sem nulos; fila sem salto.
-- ============================================================================================

DO $recalculo$
DECLARE
  v_cmd   text;
  v_antes bigint;
  v_ids   bigint[];
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'daily-calculate-scores' AND active;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'R0 FALHOU: job daily-calculate-scores ausente ou inativo';
  END IF;

  SELECT coalesce(max(id), 0) INTO v_antes FROM net.http_request_queue;
  EXECUTE v_cmd;

  -- Postcondição: exatamente 1 chamada desta execução para a calculate-scores. pg_net só dispara após o COMMIT.
  SELECT array_agg(q.id ORDER BY q.id) INTO v_ids
    FROM net.http_request_queue q
   WHERE q.id > v_antes AND q.url LIKE '%/functions/v1/calculate-scores%';
  IF coalesce(cardinality(v_ids), 0) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'R1 FALHOU: % chamadas enfileiradas, esperado 1', coalesce(cardinality(v_ids), 0);
  END IF;
  RAISE NOTICE 'recalculo v1.7 enfileirado, id pg_net: %', v_ids;
END
$recalculo$;
