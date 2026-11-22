-- ============================================================================================
-- Recompute dos derivados após o backfill de pedido CANCELADO no Omie (#4121) [money-path]
--
-- O QUE: os derivados que se regeneram sozinhos só pegariam o backfill no próximo ciclo
-- (customer_metrics_mv a cada 6h; farmer_client_scores às 06:00 UTC). Este arquivo os re-invoca
-- AGORA, pelos comandos dos PRÓPRIOS jobs (lidos de cron.job — o segredo do calculate-scores fica no
-- vault, nunca neste arquivo):
--   1. `afiacao_customer_metrics_refresh_6h` → public.refresh_customer_metrics() (síncrono, ~7s).
--   2. `daily-calculate-scores` → net.http_post (assíncrono: pg_net só dispara após o COMMIT, então
--      a edge lê a mv já atualizada).
-- NÃO mexe em histórico congelado (meta_potencial_mensal, carteira_positivacao_snapshot de meses
-- passados) — isso é decisão do founder.
--
-- PRÉ-CONDIÇÃO: aplicar SÓ DEPOIS de db/backfill-pedido-cancelado-omie-20261121.sql (R0 confere).
-- Idempotente: re-rodar só recalcula; lease ocupado na edge → skipped:true (conferir a resposta).
-- APLICAR: bun run db:aplicar db/2026-11-22-recompute-pos-backfill-cancelado.sql
-- VALIDAR (psql-ro): net._http_response do id do NOTICE = 200 e não skipped.
-- ============================================================================================

DO $recompute$
DECLARE
  v_cmd_mv  text;
  v_cmd_sc  text;
  v_antes   bigint;
  v_ids     bigint[];
  v_resto   int;
BEGIN
  -- R0: o backfill já rodou — pedido cancelado no Omie (amostra fixa, 1º PID de cada conta da
  -- lista embutida) não está mais no universo de venda. Recompute antes do backfill seria inútil.
  SELECT count(*) INTO v_resto
    FROM public.sales_orders so
   WHERE so.deleted_at IS NULL
     AND ((so.account = 'oben' AND so.omie_pedido_id = 8700838258)
       OR (so.account = 'colacor' AND so.omie_pedido_id = 403840138))
     AND so.status <> ALL (ARRAY['cancelado','rascunho','pendente','orcamento']);
  IF v_resto IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'R0 FALHOU: o backfill de pedido cancelado ainda não foi aplicado (% linha(s) da amostra no universo de venda)', v_resto;
  END IF;

  SELECT command INTO v_cmd_mv FROM cron.job WHERE jobname = 'afiacao_customer_metrics_refresh_6h' AND active;
  SELECT command INTO v_cmd_sc FROM cron.job WHERE jobname = 'daily-calculate-scores' AND active;
  IF v_cmd_mv IS NULL OR v_cmd_sc IS NULL THEN
    RAISE EXCEPTION 'R1 FALHOU: job ausente ou inativo (mv %, scores %)', v_cmd_mv IS NOT NULL, v_cmd_sc IS NOT NULL;
  END IF;

  EXECUTE v_cmd_mv;
  RAISE NOTICE 'recompute: customer_metrics_mv atualizada';

  SELECT coalesce(max(id), 0) INTO v_antes FROM net.http_request_queue;
  EXECUTE v_cmd_sc;
  SELECT array_agg(q.id ORDER BY q.id) INTO v_ids
    FROM net.http_request_queue q
   WHERE q.id > v_antes AND q.url LIKE '%/functions/v1/calculate-scores%';
  IF coalesce(cardinality(v_ids), 0) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'R2 FALHOU: % chamadas enfileiradas, esperado 1', coalesce(cardinality(v_ids), 0);
  END IF;
  RAISE NOTICE 'recompute: calculate-scores enfileirado, id pg_net: %', v_ids;
END
$recompute$;
