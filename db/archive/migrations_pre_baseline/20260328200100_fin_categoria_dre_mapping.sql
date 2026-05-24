-- ============================================================
-- MÓDULO FINANCEIRO: Mapeamento de categorias Omie → linhas DRE
-- Permite configuração manual de como cada categoria é classificada
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_categoria_dre_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc','_default')),
  omie_codigo text NOT NULL,
  dre_linha text NOT NULL CHECK (dre_linha IN (
    'receita_bruta',
    'deducoes',
    'cmv',
    'despesas_operacionais',
    'despesas_administrativas',
    'despesas_comerciais',
    'despesas_financeiras',
    'receitas_financeiras',
    'outras_receitas',
    'outras_despesas',
    'impostos'
  )),
  notas text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, omie_codigo)
);

CREATE INDEX idx_fin_cat_dre_company ON fin_categoria_dre_mapping(company);

-- Seed padrões iniciais (categorias comuns do Omie)
-- Esses são overrideable por empresa com company != '_default'
INSERT INTO fin_categoria_dre_mapping (company, omie_codigo, dre_linha, notas) VALUES
  -- Receitas
  ('_default', '1.01.01', 'receita_bruta', 'Venda de mercadorias'),
  ('_default', '1.01.02', 'receita_bruta', 'Venda de produtos'),
  ('_default', '1.01.03', 'receita_bruta', 'Prestação de serviços'),
  ('_default', '1.01.04', 'receita_bruta', 'Outras receitas operacionais'),
  -- Deduções
  ('_default', '1.01.05', 'deducoes', 'Devoluções e cancelamentos'),
  ('_default', '1.01.06', 'deducoes', 'Descontos incondicionais'),
  -- CMV
  ('_default', '2.01.01', 'cmv', 'Custo das mercadorias vendidas'),
  ('_default', '2.01.02', 'cmv', 'Custo dos produtos vendidos'),
  ('_default', '2.01.03', 'cmv', 'Custo dos serviços prestados'),
  ('_default', '2.01.04', 'cmv', 'Compras de matéria-prima'),
  -- Despesas administrativas
  ('_default', '3.01.01', 'despesas_administrativas', 'Folha de pagamento'),
  ('_default', '3.01.02', 'despesas_administrativas', 'Encargos sociais'),
  ('_default', '3.01.03', 'despesas_administrativas', 'Aluguel e condomínio'),
  ('_default', '3.01.04', 'despesas_administrativas', 'Água/luz/telefone'),
  ('_default', '3.01.05', 'despesas_administrativas', 'Material de escritório'),
  ('_default', '3.01.06', 'despesas_administrativas', 'Contabilidade e consultoria'),
  ('_default', '3.01.07', 'despesas_administrativas', 'TI e software'),
  -- Despesas comerciais
  ('_default', '3.02.01', 'despesas_comerciais', 'Comissões sobre vendas'),
  ('_default', '3.02.02', 'despesas_comerciais', 'Fretes sobre vendas'),
  ('_default', '3.02.03', 'despesas_comerciais', 'Marketing e publicidade'),
  ('_default', '3.02.04', 'despesas_comerciais', 'Viagens e representação'),
  -- Despesas financeiras
  ('_default', '4.01.01', 'despesas_financeiras', 'Juros sobre empréstimos'),
  ('_default', '4.01.02', 'despesas_financeiras', 'Tarifas bancárias'),
  ('_default', '4.01.03', 'despesas_financeiras', 'IOF'),
  ('_default', '4.01.04', 'despesas_financeiras', 'Descontos concedidos'),
  -- Receitas financeiras
  ('_default', '4.02.01', 'receitas_financeiras', 'Rendimentos de aplicações'),
  ('_default', '4.02.02', 'receitas_financeiras', 'Descontos obtidos'),
  ('_default', '4.02.03', 'receitas_financeiras', 'Juros recebidos'),
  -- Impostos
  ('_default', '5.01.01', 'impostos', 'DAS (Simples Nacional)'),
  ('_default', '5.01.02', 'impostos', 'IRPJ'),
  ('_default', '5.01.03', 'impostos', 'CSLL'),
  ('_default', '5.01.04', 'impostos', 'PIS'),
  ('_default', '5.01.05', 'impostos', 'COFINS'),
  ('_default', '5.01.06', 'impostos', 'ISS'),
  ('_default', '5.01.07', 'impostos', 'ICMS'),
  ('_default', '5.01.08', 'impostos', 'IPI')
ON CONFLICT (company, omie_codigo) DO NOTHING;

-- RLS
ALTER TABLE fin_categoria_dre_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fin_cat_dre_select" ON fin_categoria_dre_mapping FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_cat_dre_all_service" ON fin_categoria_dre_mapping FOR ALL USING (auth.role() = 'service_role');
-- Admin pode fazer insert/update/delete
CREATE POLICY "fin_cat_dre_admin_modify" ON fin_categoria_dre_mapping FOR ALL USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
);
