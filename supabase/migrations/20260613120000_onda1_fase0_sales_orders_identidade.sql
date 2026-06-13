-- Onda 1 / Fase 0 — Idempotência do pedido de venda.
-- checkout_id: chave de idempotência por TENTATIVA de envio (estável entre retries).
-- origem / atendimento_id: plumbing forward-looking (a FASE 1 os escreve; nulos aqui).
-- ⚠️ MONEY-PATH: aplicar via SQL Editor do Lovable; validar com a query no fim.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS checkout_id uuid,
  ADD COLUMN IF NOT EXISTS origem text,
  ADD COLUMN IF NOT EXISTS atendimento_id uuid;

-- (1) Idempotência por tentativa: impede 2 linhas para o mesmo (checkout_id, account).
--     PARCIAL → linhas legadas (checkout_id nulo) não colidem nem são afetadas.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_checkout_account_uq
  ON public.sales_orders (checkout_id, account)
  WHERE checkout_id IS NOT NULL;

-- (2) Âncora de reconciliação: 1 pedido Omie só pode estar vinculado a 1 linha por conta.
--     Suporta a reconciliação (Task 5) e protege contra dupla-vinculação.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_account_omiepedido_uq
  ON public.sales_orders (account, omie_pedido_id)
  WHERE omie_pedido_id IS NOT NULL;

-- (3) Métrica "conversão por origem" (Fase 1+), sem seq-scan.
CREATE INDEX IF NOT EXISTS idx_sales_orders_origem
  ON public.sales_orders (origem)
  WHERE origem IS NOT NULL;

-- ── Validação pós-apply (o SELECT abaixo confirma o resultado no SQL Editor) ──
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders'
     AND column_name IN ('checkout_id','origem','atendimento_id')) AS colunas_3,            -- esperado: 3
  (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_checkout_account_uq') AS uq_checkout_1, -- esperado: 1
  (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_account_omiepedido_uq') AS uq_omie_1,   -- esperado: 1
  (SELECT count(*) FROM pg_indexes WHERE indexname='idx_sales_orders_origem') AS idx_origem_1;           -- esperado: 1
