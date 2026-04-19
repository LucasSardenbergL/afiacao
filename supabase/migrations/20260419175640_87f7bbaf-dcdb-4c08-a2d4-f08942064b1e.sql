CREATE TABLE IF NOT EXISTS public.venda_items_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  nfe_chave_acesso text,
  nfe_numero text,
  nfe_serie text,
  data_emissao date NOT NULL,
  cliente_codigo_omie bigint,
  cliente_razao_social text,
  cliente_cnpj_cpf text,
  cliente_uf text,
  cliente_cidade text,
  sku_codigo_omie bigint NOT NULL,
  sku_codigo text,
  sku_descricao text,
  sku_ncm text,
  sku_unidade text,
  quantidade numeric NOT NULL,
  valor_unitario numeric,
  valor_total numeric,
  cfop text,
  raw_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nfe_chave_acesso, sku_codigo_omie)
);

CREATE INDEX IF NOT EXISTS idx_venda_empresa_data ON public.venda_items_history (empresa, data_emissao DESC);
CREATE INDEX IF NOT EXISTS idx_venda_sku_data ON public.venda_items_history (empresa, sku_codigo_omie, data_emissao);
CREATE INDEX IF NOT EXISTS idx_venda_cliente ON public.venda_items_history (empresa, cliente_codigo_omie);

ALTER TABLE public.venda_items_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users read venda_items_history"
  ON public.venda_items_history FOR SELECT
  TO authenticated USING (true);
