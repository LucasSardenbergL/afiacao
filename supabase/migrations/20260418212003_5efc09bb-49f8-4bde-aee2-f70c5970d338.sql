ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS numero_contrato_fornecedor text;

CREATE INDEX IF NOT EXISTS idx_pot_num_contrato
  ON public.purchase_orders_tracking (empresa, fornecedor_codigo_omie, numero_contrato_fornecedor)
  WHERE numero_contrato_fornecedor IS NOT NULL;