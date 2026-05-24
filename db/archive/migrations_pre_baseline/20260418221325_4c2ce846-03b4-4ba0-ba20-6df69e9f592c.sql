ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS cte_valor_frete numeric(15,2),
  ADD COLUMN IF NOT EXISTS cte_transportadora_nome_real text,
  ADD COLUMN IF NOT EXISTS cte_transportadora_cnpj text,
  ADD COLUMN IF NOT EXISTS match_cte_score numeric(3,2);

CREATE INDEX IF NOT EXISTS idx_pot_cte_match_pending
  ON public.purchase_orders_tracking (empresa, fornecedor_codigo_omie, t2_data_faturamento)
  WHERE nfe_chave_acesso IS NOT NULL AND t3_data_cte IS NULL;