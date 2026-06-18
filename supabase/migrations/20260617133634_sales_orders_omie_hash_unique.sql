-- ============================================================
-- sales_orders: índice UNIQUE PARCIAL em (account, hash_payload) p/ pedidos do sync Omie.
--
-- Por quê (MONEY-PATH, achado Codex #3 do challenge 2026-06-17): o sync de pedidos
-- (omie-vendas-sync / sync_pedidos) é INSERT-ONLY e dedupa por um Set EM MEMÓRIA de
-- hash_payload pré-carregado no início da invocação. Isso NÃO segura concorrência: dois
-- runners que pré-carregam antes de qualquer insert podem inserir o MESMO pedido →
-- sales_orders + order_items duplicados → positivação/OTE/COMISSÃO dobrada. O cursor+lease
-- (20260617133633) reduz a concorrência, mas o lease é best-effort (race de lease morto);
-- a ÚNICA garantia de integridade é o banco. Este índice é o guard na fronteira que toda
-- via de insert cruza (princípio money-path #5): um insert duplicado vira `unique_violation`
-- (23505), que o fallback one-by-one do edge já trata pulando — idempotência REAL.
--
-- PARCIAL `WHERE hash_payload LIKE 'omie\_%'`: escopa SÓ os pedidos criados pelo sync
-- (hash `omie_<conta>_<codigoPedido>`, único por conta+pedido). Verificado em prod
-- (psql-ro, 2026-06-17): 0 duplicatas nesse subset (6.242 pedidos: 5.123 oben + 1.119
-- colacor). As 488 linhas duplicadas de sales_orders são pedidos `cancelado` com hash
-- placeholder não-omie (ex.: '-cah8zx' ×253) — EXCLUÍDAS pelo predicado, intocadas.
--
-- ⚠️ Idempotente. NÃO usa CONCURRENTLY (o SQL Editor do Lovable roda em transação; trava
-- a tabela brevemente — aceitável, sales_orders é pequena). Se o apply falhar com
-- "could not create unique index ... duplicate key", surgiu duplicata omie_ NOVA entre a
-- verificação e o apply → me avise (é um bug de sync a investigar ANTES de forçar o índice).
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload)
  WHERE hash_payload LIKE 'omie\_%';
