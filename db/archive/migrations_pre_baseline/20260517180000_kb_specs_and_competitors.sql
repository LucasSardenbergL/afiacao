-- PR6b: KB specs + competitors skeleton

-- 1. Tabela de specs estruturados (1 row por produto da Sayerlack/Colacor)
CREATE TABLE IF NOT EXISTS public.kb_product_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.kb_documents(id) ON DELETE SET NULL,
  product_code text NOT NULL UNIQUE,        -- ex: 'FO20.6827.00'
  product_name text NOT NULL,
  supplier text NOT NULL DEFAULT 'sayerlack',
  product_line text,                         -- 'wood_pu' | 'wood_nitro' | 'hydropoxi' | 'auto'
  product_category text,                     -- 'primer' | 'verniz' | 'tinta' | 'catalisador' | 'diluente'

  -- Propriedades físico-químicas
  densidade_g_cm3 numeric,
  solidos_pct numeric,
  viscosidade_aplicacao_s numeric,
  viscosidade_copo text,                     -- 'CF4' | 'CF6' | 'CF8'
  brilho_ub numeric,                         -- unidades de brilho
  dureza text,                               -- '3H', '2H' etc.

  -- Aplicação
  rendimento_m2_por_litro numeric,           -- calculado ou explícito
  demaos_recomendadas integer,
  gramatura_g_m2_min integer,
  gramatura_g_m2_max integer,
  pot_life_horas numeric,
  temp_aplicacao_c_min numeric,
  temp_aplicacao_c_max numeric,
  umidade_aplicacao_pct_min numeric,
  umidade_aplicacao_pct_max numeric,

  -- Compatibilidade
  catalisador_codigo text,                   -- ex: 'FC.6952'
  catalisador_proporcao_pct numeric,
  diluente_codigo text,                      -- ex: 'DF.4068'
  equipamentos_aplicacao text[],             -- ['pistola_convencional', 'tanque_pressao']
  lixa_recomendada text,
  substrato text[],                          -- ['madeira', 'mdf']

  -- Secagem
  secagem_manuseio_h numeric,
  secagem_empilhamento_h numeric,
  secagem_total_h numeric,

  -- Armazenamento
  validade_dias integer,
  temp_armazenamento_c_min integer,
  temp_armazenamento_c_max integer,

  -- Compliance
  certificacoes_aplicaveis text[],           -- ['IKEA', 'LGA', 'Proposition_65']
  isento_metais_pesados text[],              -- ['Cd', 'Pb', etc.]
  isento_substancias text[],                 -- ['amianto', 'formaldeido']

  -- Notas qualitativas
  diferenciais_chave text[],                 -- ['resistencia_risco_superior', 'toque_sedoso']
  uso_recomendado text,
  publico_alvo text,

  -- Metadata
  extraction_confidence numeric,             -- 0-1 (Claude reporta)
  extraction_gaps text[],                    -- campos que Claude não conseguiu extrair
  extracted_by uuid REFERENCES auth.users(id),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Concorrentes (vazio — populado por PR8)
CREATE TABLE IF NOT EXISTS public.kb_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,                 -- 'Farben Tintas', 'Vernit', 'Rosalen'
  tipo text CHECK (tipo IN ('regional', 'nacional', 'importado')),
  regiao_principal text,                     -- 'mg', 'sul', 'sp', 'nacional'
  segmento_atuacao text[],                   -- ['moveleiro', 'industrial', 'automotivo']
  notas_estrategicas text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Produtos do concorrente (vazio — populado via UI ou auto-detect)
CREATE TABLE IF NOT EXISTS public.kb_competitor_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id uuid NOT NULL REFERENCES public.kb_competitors(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  category text,                             -- mesmo enum de kb_product_specs.product_category
  rendimento_m2_por_litro numeric,
  solidos_pct numeric,
  pot_life_horas numeric,
  validade_dias integer,
  preco_referencia_l numeric,
  preco_atualizado_em timestamptz,
  fonte_preco text CHECK (fonte_preco IN ('vendedor', 'cotacao', 'site', 'estimado', 'detectado_ia')),
  pontos_fortes text[],
  pontos_fracos text[],
  nosso_equivalente_product_code text,       -- referência cruzada com nossos kb_product_specs.product_code
  argumentos_comparativos jsonb,             -- estrutura aberta pra flexibilidade
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_kb_product_specs_product_code ON public.kb_product_specs (product_code);
CREATE INDEX IF NOT EXISTS idx_kb_product_specs_supplier_line ON public.kb_product_specs (supplier, product_line);
CREATE INDEX IF NOT EXISTS idx_kb_competitor_products_competitor ON public.kb_competitor_products (competitor_id);
CREATE INDEX IF NOT EXISTS idx_kb_competitor_products_equivalent ON public.kb_competitor_products (nosso_equivalente_product_code);

-- 5. Triggers updated_at (reusa função do PR6a se existir; senão cria)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kb_documents_set_updated_at') THEN
    CREATE OR REPLACE FUNCTION public.kb_documents_set_updated_at()
    RETURNS trigger AS $func$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $func$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_kb_product_specs_updated_at ON public.kb_product_specs;
CREATE TRIGGER trg_kb_product_specs_updated_at
  BEFORE UPDATE ON public.kb_product_specs
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

DROP TRIGGER IF EXISTS trg_kb_competitors_updated_at ON public.kb_competitors;
CREATE TRIGGER trg_kb_competitors_updated_at
  BEFORE UPDATE ON public.kb_competitors
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

DROP TRIGGER IF EXISTS trg_kb_competitor_products_updated_at ON public.kb_competitor_products;
CREATE TRIGGER trg_kb_competitor_products_updated_at
  BEFORE UPDATE ON public.kb_competitor_products
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

-- 6. RLS — staff lê, master CRUD
ALTER TABLE public.kb_product_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_competitor_products ENABLE ROW LEVEL SECURITY;

-- kb_product_specs
CREATE POLICY "kb_product_specs_select_staff" ON public.kb_product_specs
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_product_specs_insert_staff" ON public.kb_product_specs
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_product_specs_update_master" ON public.kb_product_specs
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'master'::app_role)
    OR extracted_by = auth.uid()
  );
CREATE POLICY "kb_product_specs_delete_master" ON public.kb_product_specs
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- kb_competitors
CREATE POLICY "kb_competitors_select_staff" ON public.kb_competitors
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitors_insert_staff" ON public.kb_competitors
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitors_update_staff" ON public.kb_competitors
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitors_delete_master" ON public.kb_competitors
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- kb_competitor_products
CREATE POLICY "kb_competitor_products_select_staff" ON public.kb_competitor_products
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitor_products_insert_staff" ON public.kb_competitor_products
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitor_products_update_staff" ON public.kb_competitor_products
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitor_products_delete_master" ON public.kb_competitor_products
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- 7. Comentários
COMMENT ON TABLE public.kb_product_specs IS 'Specs estruturados extraídos de kb_documents via Claude. 1 row por produto Sayerlack.';
COMMENT ON TABLE public.kb_competitors IS 'Concorrentes regionais/nacionais. Populado por vendedores via UI ou auto-detect de transcripts.';
COMMENT ON TABLE public.kb_competitor_products IS 'Produtos específicos dos concorrentes com specs comparáveis aos nossos.';
