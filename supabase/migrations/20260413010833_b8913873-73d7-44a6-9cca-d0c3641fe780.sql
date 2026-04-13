
-- ===========================================
-- 0. warehouses (armazéns do grupo)
-- ===========================================
CREATE TABLE public.warehouses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(10) NOT NULL UNIQUE,
  name TEXT NOT NULL,
  cnpj VARCHAR(14),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view warehouses"
  ON public.warehouses FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert warehouses"
  ON public.warehouses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update warehouses"
  ON public.warehouses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER update_warehouses_updated_at
  BEFORE UPDATE ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed initial warehouses
INSERT INTO public.warehouses (code, name) VALUES
  ('OB', 'Oben'),
  ('CC', 'Colacor');

-- ===========================================
-- 1. nfe_recebimentos
-- ===========================================
CREATE TABLE public.nfe_recebimentos (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id),
  numero_nfe VARCHAR(20) NOT NULL,
  serie_nfe VARCHAR(5),
  chave_acesso VARCHAR(44) NOT NULL UNIQUE,
  cnpj_emitente VARCHAR(14) NOT NULL,
  razao_social_emitente TEXT,
  data_emissao DATE,
  valor_total DECIMAL(15,2),
  xml_completo TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pendente',
  omie_nfe_id BIGINT,
  omie_id_receb BIGINT,
  conferente_id UUID,
  conferido_at TIMESTAMPTZ,
  efetivado_at TIMESTAMPTZ,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nfe_recebimentos_status ON public.nfe_recebimentos(status);
CREATE INDEX idx_nfe_recebimentos_cnpj ON public.nfe_recebimentos(cnpj_emitente);
CREATE INDEX idx_nfe_recebimentos_warehouse ON public.nfe_recebimentos(warehouse_id);
CREATE INDEX idx_nfe_recebimentos_created ON public.nfe_recebimentos(created_at);

ALTER TABLE public.nfe_recebimentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view nfe_recebimentos"
  ON public.nfe_recebimentos FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert nfe_recebimentos"
  ON public.nfe_recebimentos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update nfe_recebimentos"
  ON public.nfe_recebimentos FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER update_nfe_recebimentos_updated_at
  BEFORE UPDATE ON public.nfe_recebimentos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================
-- 2. nfe_recebimento_itens
-- ===========================================
CREATE TABLE public.nfe_recebimento_itens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nfe_recebimento_id UUID NOT NULL REFERENCES public.nfe_recebimentos(id) ON DELETE CASCADE,
  sequencia INTEGER NOT NULL,
  codigo_produto VARCHAR(60),
  descricao TEXT NOT NULL,
  ncm VARCHAR(8),
  ean VARCHAR(14),
  unidade_nfe VARCHAR(10) NOT NULL,
  quantidade_nfe DECIMAL(15,4) NOT NULL,
  valor_unitario DECIMAL(15,4),
  valor_total DECIMAL(15,2),
  unidade_estoque VARCHAR(10),
  quantidade_convertida DECIMAL(15,4),
  quantidade_conferida INTEGER NOT NULL DEFAULT 0,
  quantidade_esperada INTEGER NOT NULL,
  status_item VARCHAR(20) NOT NULL DEFAULT 'pendente',
  observacao_divergencia TEXT,
  produto_omie_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nfe_recebimento_itens_nfe ON public.nfe_recebimento_itens(nfe_recebimento_id);

ALTER TABLE public.nfe_recebimento_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view nfe_recebimento_itens"
  ON public.nfe_recebimento_itens FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert nfe_recebimento_itens"
  ON public.nfe_recebimento_itens FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update nfe_recebimento_itens"
  ON public.nfe_recebimento_itens FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete nfe_recebimento_itens"
  ON public.nfe_recebimento_itens FOR DELETE TO authenticated USING (true);

-- ===========================================
-- 3. nfe_lotes_escaneados
-- ===========================================
CREATE TABLE public.nfe_lotes_escaneados (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nfe_recebimento_item_id UUID NOT NULL REFERENCES public.nfe_recebimento_itens(id) ON DELETE CASCADE,
  numero_lote VARCHAR(30) NOT NULL,
  data_fabricacao DATE,
  data_validade DATE,
  metodo_leitura VARCHAR(10) NOT NULL DEFAULT 'manual',
  escaneado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  escaneado_por UUID
);

CREATE INDEX idx_nfe_lotes_item ON public.nfe_lotes_escaneados(nfe_recebimento_item_id);
CREATE INDEX idx_nfe_lotes_numero ON public.nfe_lotes_escaneados(numero_lote);

ALTER TABLE public.nfe_lotes_escaneados ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view nfe_lotes_escaneados"
  ON public.nfe_lotes_escaneados FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert nfe_lotes_escaneados"
  ON public.nfe_lotes_escaneados FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update nfe_lotes_escaneados"
  ON public.nfe_lotes_escaneados FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ===========================================
-- 4. conversao_unidades
-- ===========================================
CREATE TABLE public.conversao_unidades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cnpj_fornecedor VARCHAR(14) NOT NULL,
  codigo_produto_fornecedor VARCHAR(60) NOT NULL,
  descricao_produto TEXT,
  unidade_origem VARCHAR(10) NOT NULL,
  unidade_destino VARCHAR(10) NOT NULL,
  fator_conversao DECIMAL(15,6) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversao_fornecedor_produto UNIQUE (cnpj_fornecedor, codigo_produto_fornecedor)
);

CREATE INDEX idx_conversao_cnpj ON public.conversao_unidades(cnpj_fornecedor);

ALTER TABLE public.conversao_unidades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view conversao_unidades"
  ON public.conversao_unidades FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert conversao_unidades"
  ON public.conversao_unidades FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update conversao_unidades"
  ON public.conversao_unidades FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete conversao_unidades"
  ON public.conversao_unidades FOR DELETE TO authenticated USING (true);

CREATE TRIGGER update_conversao_unidades_updated_at
  BEFORE UPDATE ON public.conversao_unidades
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================
-- 5. cte_associados
-- ===========================================
CREATE TABLE public.cte_associados (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nfe_recebimento_id UUID NOT NULL REFERENCES public.nfe_recebimentos(id) ON DELETE CASCADE,
  numero_cte VARCHAR(20),
  chave_acesso_cte VARCHAR(44) NOT NULL UNIQUE,
  cnpj_transportadora VARCHAR(14),
  razao_social_transportadora TEXT,
  valor_frete DECIMAL(15,2),
  xml_cte TEXT,
  omie_cte_id BIGINT,
  status VARCHAR(20) NOT NULL DEFAULT 'pendente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cte_associados_nfe ON public.cte_associados(nfe_recebimento_id);

ALTER TABLE public.cte_associados ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view cte_associados"
  ON public.cte_associados FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert cte_associados"
  ON public.cte_associados FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update cte_associados"
  ON public.cte_associados FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete cte_associados"
  ON public.cte_associados FOR DELETE TO authenticated USING (true);

-- ===========================================
-- Service role policies for webhook (edge function)
-- ===========================================
CREATE POLICY "Service role full access nfe_recebimentos"
  ON public.nfe_recebimentos FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access nfe_recebimento_itens"
  ON public.nfe_recebimento_itens FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access conversao_unidades"
  ON public.conversao_unidades FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access warehouses"
  ON public.warehouses FOR ALL TO service_role USING (true) WITH CHECK (true);
