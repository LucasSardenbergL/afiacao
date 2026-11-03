-- Migration: índice COMPLETO em sales_orders(account, omie_pedido_id) para o EXISTS correlacionado do
-- _data_health_compute (plano v4, lote 9 — achado de B0). Plano: docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md.
-- Análise: docs/historico/consultas-pesadas-lote9.md. Puramente ADITIVA: só CREATE INDEX IF NOT EXISTS,
-- nenhuma escrita de dado, nenhuma função/policy tocada.
-- ⚠️ NÃO auto-aplica (nome custom). Caminho: `bun run db:aplicar <este arquivo> --ensaio`, depois sem
-- --ensaio (a transação vem do executor). Fallback: SQL Editor do Lovable (transação implícita) — por isso
-- o arquivo não leva BEGIN/COMMIT. Sem CONCURRENTLY pelo mesmo motivo (ver 20261101201804); sales_orders
-- tem 32.160 linhas / 39 MB, build de fração de segundo; o lock_timeout aborta inteiro se não pegar o lock.
--
-- Evidência (psql-ro, 2026-11-02): o vigia "linha do app sem gêmeo Omie" do _data_health_compute faz, para
-- cada uma das ~25 linhas do app, `EXISTS (SELECT 1 FROM sales_orders t WHERE t.account = a.account AND
-- t.omie_pedido_id = a.omie_pedido_id AND (t.omie_payload IS NULL OR t.hash_payload = 'omie_' || …))`.
-- Os 4 índices que já começam por (account, omie_pedido_id) são PARCIAIS (hash_payload IS NULL /
-- IS NOT NULL / order_date_kpi …) e o OR do EXISTS impede o planejador de provar qualquer predicado:
-- EXPLAIN ANALYZE deu SubPlan = Seq Scan × 25 loops, 60.525 buffers, 911 ms, 26 seq scans por chamada.
-- A função roda 2× a cada :00/:30 (cron data_health_watchdog) e a cada 120 s por aba de staff em foco
-- (get_data_health no DataHealthBadge do AppShell) — os 51 seq scans de sales_orders por tick do cron.
-- Índice COMPLETO e não `WHERE omie_pedido_id IS NOT NULL`: 32.158 de 32.160 linhas têm o id (o parcial não
-- economiza nada) e o completo não depende de prova de predicado. account/omie_pedido_id não mudam após a
-- gravação, e a tabela já está em 0% HOT (5.231 updates/54 h), então o custo de escrita é 1 entrada por insert.
--
-- Pós-condição: o DO $post$ exige a DEFINIÇÃO esperada (um homônimo com outras colunas faria o IF NOT EXISTS
-- pular em silêncio), válida e pronta.

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_sales_orders_account_omie_pedido
  ON public.sales_orders (account, omie_pedido_id);

DO $post$
DECLARE
  v_def text;
  v_ok boolean;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid), x.indisvalid AND x.indisready
    INTO v_def, v_ok
    FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class c ON c.oid = x.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'idx_sales_orders_account_omie_pedido';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POS: índice idx_sales_orders_account_omie_pedido não existe — o vigia de gêmeo segue em 26 seq scans por chamada';
  END IF;
  IF v_def IS DISTINCT FROM
     'CREATE INDEX idx_sales_orders_account_omie_pedido ON public.sales_orders USING btree (account, omie_pedido_id)' THEN
    RAISE EXCEPTION 'POS: índice idx_sales_orders_account_omie_pedido existe com outra definição (%) — o IF NOT EXISTS o pulou', v_def;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'POS: índice idx_sales_orders_account_omie_pedido inválido ou não pronto — o planejador não o usa';
  END IF;
  RAISE NOTICE 'POS ok: idx_sales_orders_account_omie_pedido válido e pronto';
END
$post$;
