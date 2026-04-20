-- Cache de mapeamento fornecedor_nome -> codigo_cliente_fornecedor Omie
CREATE TABLE IF NOT EXISTS public.fornecedor_omie_cache (
  empresa text NOT NULL,
  fornecedor_nome text NOT NULL,
  omie_codigo_cliente_fornecedor bigint NOT NULL,
  razao_social_omie text,
  cnpj text,
  cached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa, fornecedor_nome)
);

ALTER TABLE public.fornecedor_omie_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view fornecedor cache"
  ON public.fornecedor_omie_cache FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager','employee'))
  );

CREATE POLICY "Service role manages fornecedor cache"
  ON public.fornecedor_omie_cache FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);