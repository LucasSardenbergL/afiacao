
-- 1. Alter omie_products for tintometric support
ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS is_tintometric boolean DEFAULT false;
ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tint_type text;

-- 2. Enable pg_trgm extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 3. tint_corantes
CREATE TABLE public.tint_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  id_corante_sayersystem text NOT NULL,
  descricao text NOT NULL,
  volume_total_ml numeric NOT NULL,
  peso_especifico numeric,
  codigo_barras text,
  omie_product_id uuid REFERENCES public.omie_products(id),
  ativo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (account, id_corante_sayersystem)
);

ALTER TABLE public.tint_corantes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_corantes" ON public.tint_corantes
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_corantes" ON public.tint_corantes
  FOR SELECT TO authenticated
  USING (true);

-- 4. tint_produtos
CREATE TABLE public.tint_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  cod_produto text NOT NULL,
  descricao text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (account, cod_produto)
);

ALTER TABLE public.tint_produtos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_produtos" ON public.tint_produtos
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_produtos" ON public.tint_produtos
  FOR SELECT TO authenticated
  USING (true);

-- 5. tint_bases
CREATE TABLE public.tint_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  id_base_sayersystem text NOT NULL,
  descricao text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (account, id_base_sayersystem)
);

ALTER TABLE public.tint_bases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_bases" ON public.tint_bases
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_bases" ON public.tint_bases
  FOR SELECT TO authenticated
  USING (true);

-- 6. tint_embalagens
CREATE TABLE public.tint_embalagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  id_embalagem_sayersystem text NOT NULL,
  descricao text,
  volume_ml numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (account, id_embalagem_sayersystem)
);

ALTER TABLE public.tint_embalagens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_embalagens" ON public.tint_embalagens
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_embalagens" ON public.tint_embalagens
  FOR SELECT TO authenticated
  USING (true);

-- 7. tint_skus
CREATE TABLE public.tint_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  produto_id uuid NOT NULL REFERENCES public.tint_produtos(id),
  base_id uuid NOT NULL REFERENCES public.tint_bases(id),
  embalagem_id uuid NOT NULL REFERENCES public.tint_embalagens(id),
  omie_product_id uuid REFERENCES public.omie_products(id),
  imposto_pct numeric DEFAULT 0,
  margem_pct numeric DEFAULT 0,
  codigo_etiqueta text,
  ativo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (account, produto_id, base_id, embalagem_id)
);

ALTER TABLE public.tint_skus ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_skus" ON public.tint_skus
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_skus" ON public.tint_skus
  FOR SELECT TO authenticated
  USING (true);

-- 8. tint_colecoes
CREATE TABLE public.tint_colecoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  id_colecao_sayersystem text,
  descricao text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.tint_colecoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_colecoes" ON public.tint_colecoes
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_colecoes" ON public.tint_colecoes
  FOR SELECT TO authenticated
  USING (true);

-- 9. tint_subcolecoes
CREATE TABLE public.tint_subcolecoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  colecao_id uuid REFERENCES public.tint_colecoes(id),
  id_subcolecao_sayersystem text,
  descricao text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.tint_subcolecoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_subcolecoes" ON public.tint_subcolecoes
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_subcolecoes" ON public.tint_subcolecoes
  FOR SELECT TO authenticated
  USING (true);

-- 10. tint_importacoes
CREATE TABLE public.tint_importacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  tipo text NOT NULL,
  arquivo_nome text NOT NULL,
  arquivo_hash text NOT NULL,
  total_registros integer,
  registros_importados integer,
  registros_atualizados integer,
  registros_erro integer,
  status text DEFAULT 'processando',
  erros_detalhe jsonb,
  importado_por uuid,
  created_at timestamptz DEFAULT now(),
  UNIQUE (account, arquivo_hash)
);

ALTER TABLE public.tint_importacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_importacoes" ON public.tint_importacoes
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 11. tint_formulas
CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  id_seq integer,
  cor_id text NOT NULL,
  nome_cor text NOT NULL,
  produto_id uuid NOT NULL REFERENCES public.tint_produtos(id),
  base_id uuid NOT NULL REFERENCES public.tint_bases(id),
  embalagem_id uuid NOT NULL REFERENCES public.tint_embalagens(id),
  subcolecao_id uuid REFERENCES public.tint_subcolecoes(id),
  sku_id uuid REFERENCES public.tint_skus(id),
  volume_final_ml numeric,
  preco_final_sayersystem numeric,
  data_geracao timestamptz,
  personalizada boolean DEFAULT false,
  importacao_id uuid REFERENCES public.tint_importacoes(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.tint_formulas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_formulas" ON public.tint_formulas
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_formulas" ON public.tint_formulas
  FOR SELECT TO authenticated
  USING (true);

-- Unique index with COALESCE for nullable subcolecao_id
CREATE UNIQUE INDEX uq_tint_formulas_chave
  ON public.tint_formulas (account, cor_id, produto_id, base_id,
    COALESCE(subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid), embalagem_id);

-- Performance indexes
CREATE INDEX idx_tint_formulas_busca_cor ON public.tint_formulas (account, sku_id, cor_id);
CREATE INDEX idx_tint_formulas_nome_cor ON public.tint_formulas USING gin (nome_cor gin_trgm_ops);

-- 12. tint_formula_itens
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid NOT NULL REFERENCES public.tint_formulas(id) ON DELETE CASCADE,
  corante_id uuid NOT NULL REFERENCES public.tint_corantes(id),
  ordem integer NOT NULL,
  qtd_ml numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (formula_id, corante_id)
);

ALTER TABLE public.tint_formula_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_formula_itens" ON public.tint_formula_itens
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Authenticated can view tint_formula_itens" ON public.tint_formula_itens
  FOR SELECT TO authenticated
  USING (true);

-- 13. tint_vendas
CREATE TABLE public.tint_vendas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  id_venda_sayersystem text,
  data_venda timestamptz NOT NULL,
  operador text,
  origem text DEFAULT 'manual',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.tint_vendas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_vendas" ON public.tint_vendas
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 14. tint_vendas_itens
CREATE TABLE public.tint_vendas_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id uuid NOT NULL REFERENCES public.tint_vendas(id) ON DELETE CASCADE,
  formula_id uuid REFERENCES public.tint_formulas(id),
  sku_id uuid REFERENCES public.tint_skus(id),
  cor_id text,
  nome_cor text,
  volume_dosado_ml numeric,
  preco_praticado numeric,
  personalizada boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.tint_vendas_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tint_vendas_itens" ON public.tint_vendas_itens
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
