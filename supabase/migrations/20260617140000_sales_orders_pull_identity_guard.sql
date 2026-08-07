-- Guard de identidade do PULL — impede DUPLICATA de pedido vinda do sync de entrada do Omie.
-- Provado em PG17 local: db/test-sales-orders-pull-identity-guard.sh (falsificado).
--
-- ⚠️⚠️ NÃO APLICAR ISOLADO / FORA DE ORDEM ⚠️⚠️  (handoff sequenciado — ver docs/historico)
-- PRÉ-REQUISITOS, NESTA ORDEM (senão o CREATE FALHA por violação, ou o sync degrada ruidoso):
--   1. Edge omie-vendas-sync (sync_pedidos) consertado + deployado: dedup por omie_pedido_id
--      (não hash_payload) + tratar 23505 como "já existe" (backstop).
--   2. Edge sync-reprocess consertado + deployado: PARA de reescrever hash_payload (usa coluna
--      dedicada de change-hash) E casa por omie_pedido_id (não omie_numero_pedido + .maybeSingle()).
--   3. Limpeza das duplicatas pull JÁ existentes concluída (≈528 oben + 6 colacor) — quarentena +
--      re-vínculo das FKs NO ACTION (farmer_calls/picking_tasks/recommendation_log) — senão o
--      CREATE UNIQUE INDEX falha (fail-safe: não cria, não corrompe).
--
-- POR QUÊ: o dedup do pull usava hash_payload — mutável, nullable e MULTI-WRITER (anti-padrão
-- money-path). O sync-reprocess o de-namespaceava (omie_<account>_<cod> → hash estrutural) E linhas
-- legadas com hash NULL eram invisíveis ao Set de dedup → re-inserção → DUPLICATA (infla
-- positivação/OTE/comissão). A identidade ESTÁVEL do pull é omie_pedido_id (= codigo_pedido do Omie):
-- sempre setado no pull, NUNCA tocado pelo reprocess. checkout_id distingue push (NOT NULL) de pull
-- (NULL): o índice PARCIAL barra 2 linhas PULL do mesmo pedido SEM quebrar a dualidade push/pull
-- (o UNIQUE(account,omie_pedido_id) pleno foi removido de propósito na 20260613120000 por isso).
-- Contraparte exata do sales_orders_checkout_account_uq (que protege o push por checkout_id).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_pull_identity
  ON public.sales_orders (account, omie_pedido_id)
  WHERE checkout_id IS NULL AND omie_pedido_id IS NOT NULL;

-- ── Validação pós-apply (cole no SQL Editor após o Run) ──
SELECT
  (SELECT count(*) FROM pg_indexes
     WHERE indexname = 'uniq_sales_orders_pull_identity') AS idx_1,                 -- esperado: 1
  (SELECT count(*) FROM (
     SELECT account, omie_pedido_id FROM public.sales_orders
     WHERE checkout_id IS NULL AND omie_pedido_id IS NOT NULL
     GROUP BY account, omie_pedido_id HAVING count(*) > 1) d) AS dups_pull_restantes; -- esperado: 0
