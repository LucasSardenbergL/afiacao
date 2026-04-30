
CREATE TABLE public.sku_fornecedor_externo (
  id BIGSERIAL PRIMARY KEY,
  empresa TEXT NOT NULL,
  fornecedor_nome TEXT NOT NULL,
  sku_omie TEXT NOT NULL,
  sku_portal TEXT,
  unidade_portal TEXT NOT NULL DEFAULT 'UN',
  fator_conversao NUMERIC NOT NULL DEFAULT 1,
  ativo BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sku_fornecedor_externo_unique UNIQUE (empresa, fornecedor_nome, sku_omie)
);

CREATE INDEX idx_sku_fornecedor_externo_lookup
  ON public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie)
  WHERE ativo = true;

CREATE INDEX idx_sku_fornecedor_externo_sku_omie
  ON public.sku_fornecedor_externo (sku_omie);

ALTER TABLE public.sku_fornecedor_externo ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view sku mapping"
  ON public.sku_fornecedor_externo FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can insert sku mapping"
  ON public.sku_fornecedor_externo FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can update sku mapping"
  ON public.sku_fornecedor_externo FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can delete sku mapping"
  ON public.sku_fornecedor_externo FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER sku_fornecedor_externo_set_atualizado_em
  BEFORE UPDATE ON public.sku_fornecedor_externo
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
