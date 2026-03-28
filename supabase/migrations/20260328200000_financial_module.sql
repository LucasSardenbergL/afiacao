-- ============================================================
-- MÓDULO FINANCEIRO: Tabelas para contas a pagar, receber,
-- movimentações, categorias e contas correntes
-- ============================================================

-- Categorias financeiras (plano de contas do Omie)
CREATE TABLE IF NOT EXISTS fin_categorias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_codigo text NOT NULL,
  descricao text NOT NULL,
  tipo text CHECK (tipo IN ('R','D','T')), -- Receita, Despesa, Transferência
  conta_pai text,
  nivel integer DEFAULT 1,
  totalizadora boolean DEFAULT false,
  ativo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, omie_codigo)
);

CREATE INDEX idx_fin_categorias_company ON fin_categorias(company);
CREATE INDEX idx_fin_categorias_tipo ON fin_categorias(company, tipo);

-- Contas correntes / bancárias
CREATE TABLE IF NOT EXISTS fin_contas_correntes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_ncodcc bigint NOT NULL,
  descricao text,
  banco text,
  agencia text,
  numero_conta text,
  tipo text, -- CC, PP (poupança), CI (investimento), CX (caixa)
  saldo_data date,
  saldo_atual numeric(15,2) DEFAULT 0,
  ativo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, omie_ncodcc)
);

CREATE INDEX idx_fin_cc_company ON fin_contas_correntes(company);

-- Contas a pagar
CREATE TABLE IF NOT EXISTS fin_contas_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_codigo_lancamento bigint NOT NULL,
  omie_codigo_cliente_fornecedor bigint,
  nome_fornecedor text,
  cnpj_cpf text,
  numero_documento text,
  numero_documento_fiscal text,
  data_emissao date,
  data_vencimento date,
  data_pagamento date,
  data_previsao date,
  valor_documento numeric(15,2) NOT NULL DEFAULT 0,
  valor_pago numeric(15,2) DEFAULT 0,
  valor_desconto numeric(15,2) DEFAULT 0,
  valor_juros numeric(15,2) DEFAULT 0,
  valor_multa numeric(15,2) DEFAULT 0,
  saldo numeric(15,2) GENERATED ALWAYS AS (valor_documento - COALESCE(valor_pago, 0)) STORED,
  status_titulo text DEFAULT 'ABERTO' CHECK (status_titulo IN ('ABERTO','PAGO','PARCIAL','VENCIDO','CANCELADO','LIQUIDADO')),
  categoria_codigo text,
  categoria_descricao text,
  departamento text,
  centro_custo text,
  observacao text,
  omie_ncodcc bigint, -- conta corrente usada no pagamento
  codigo_barras text,
  tipo_documento text, -- BOL, DUP, NF, REC, etc
  id_origem text, -- referência ao pedido/NF de origem
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, omie_codigo_lancamento)
);

CREATE INDEX idx_fin_cp_company ON fin_contas_pagar(company);
CREATE INDEX idx_fin_cp_status ON fin_contas_pagar(company, status_titulo);
CREATE INDEX idx_fin_cp_vencimento ON fin_contas_pagar(company, data_vencimento);
CREATE INDEX idx_fin_cp_fornecedor ON fin_contas_pagar(company, omie_codigo_cliente_fornecedor);
CREATE INDEX idx_fin_cp_categoria ON fin_contas_pagar(company, categoria_codigo);

-- Contas a receber
CREATE TABLE IF NOT EXISTS fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_codigo_lancamento bigint NOT NULL,
  omie_codigo_cliente bigint,
  nome_cliente text,
  cnpj_cpf text,
  numero_documento text,
  numero_documento_fiscal text,
  numero_pedido text,
  data_emissao date,
  data_vencimento date,
  data_recebimento date,
  data_previsao date,
  valor_documento numeric(15,2) NOT NULL DEFAULT 0,
  valor_recebido numeric(15,2) DEFAULT 0,
  valor_desconto numeric(15,2) DEFAULT 0,
  valor_juros numeric(15,2) DEFAULT 0,
  valor_multa numeric(15,2) DEFAULT 0,
  saldo numeric(15,2) GENERATED ALWAYS AS (valor_documento - COALESCE(valor_recebido, 0)) STORED,
  status_titulo text DEFAULT 'ABERTO' CHECK (status_titulo IN ('ABERTO','RECEBIDO','PARCIAL','VENCIDO','CANCELADO','LIQUIDADO')),
  categoria_codigo text,
  categoria_descricao text,
  departamento text,
  centro_custo text,
  observacao text,
  omie_ncodcc bigint,
  vendedor_id bigint,
  tipo_documento text,
  id_origem text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, omie_codigo_lancamento)
);

CREATE INDEX idx_fin_cr_company ON fin_contas_receber(company);
CREATE INDEX idx_fin_cr_status ON fin_contas_receber(company, status_titulo);
CREATE INDEX idx_fin_cr_vencimento ON fin_contas_receber(company, data_vencimento);
CREATE INDEX idx_fin_cr_cliente ON fin_contas_receber(company, omie_codigo_cliente);
CREATE INDEX idx_fin_cr_categoria ON fin_contas_receber(company, categoria_codigo);

-- Movimentações financeiras (extratos bancários)
CREATE TABLE IF NOT EXISTS fin_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_ncodmov bigint NOT NULL,
  omie_ncodcc bigint, -- conta corrente
  data_movimento date NOT NULL,
  tipo text CHECK (tipo IN ('E','S')), -- Entrada/Saída
  valor numeric(15,2) NOT NULL,
  descricao text,
  categoria_codigo text,
  categoria_descricao text,
  conciliado boolean DEFAULT false,
  omie_codigo_lancamento bigint, -- link com CP ou CR
  natureza text, -- 'CP', 'CR', 'TRF', 'OUT'
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, omie_ncodmov)
);

CREATE INDEX idx_fin_mov_company ON fin_movimentacoes(company);
CREATE INDEX idx_fin_mov_data ON fin_movimentacoes(company, data_movimento);
CREATE INDEX idx_fin_mov_cc ON fin_movimentacoes(company, omie_ncodcc);

-- Snapshots de DRE mensal (pré-calculado para performance)
CREATE TABLE IF NOT EXISTS fin_dre_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ano integer NOT NULL,
  mes integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  receita_bruta numeric(15,2) DEFAULT 0,
  deducoes numeric(15,2) DEFAULT 0,
  receita_liquida numeric(15,2) DEFAULT 0,
  cmv numeric(15,2) DEFAULT 0, -- custo mercadoria vendida
  lucro_bruto numeric(15,2) DEFAULT 0,
  despesas_operacionais numeric(15,2) DEFAULT 0,
  despesas_administrativas numeric(15,2) DEFAULT 0,
  despesas_comerciais numeric(15,2) DEFAULT 0,
  despesas_financeiras numeric(15,2) DEFAULT 0,
  receitas_financeiras numeric(15,2) DEFAULT 0,
  resultado_operacional numeric(15,2) DEFAULT 0,
  outras_receitas numeric(15,2) DEFAULT 0,
  outras_despesas numeric(15,2) DEFAULT 0,
  resultado_antes_impostos numeric(15,2) DEFAULT 0,
  impostos numeric(15,2) DEFAULT 0,
  resultado_liquido numeric(15,2) DEFAULT 0,
  detalhamento jsonb DEFAULT '{}', -- breakdown por categoria
  calculated_at timestamptz DEFAULT now(),
  UNIQUE(company, ano, mes)
);

CREATE INDEX idx_fin_dre_company_periodo ON fin_dre_snapshots(company, ano, mes);

-- View materializada para aging de recebíveis
CREATE OR REPLACE VIEW fin_aging_receber AS
SELECT
  company,
  COUNT(*) FILTER (WHERE data_vencimento >= CURRENT_DATE) as a_vencer_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE data_vencimento >= CURRENT_DATE), 0) as a_vencer_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 1 AND 30) as vencido_1_30_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 1 AND 30), 0) as vencido_1_30_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 31 AND 60) as vencido_31_60_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 31 AND 60), 0) as vencido_31_60_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 61 AND 90) as vencido_61_90_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 61 AND 90), 0) as vencido_61_90_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento > 90) as vencido_90_plus_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento > 90), 0) as vencido_90_plus_valor
FROM fin_contas_receber
WHERE status_titulo IN ('ABERTO','VENCIDO','PARCIAL')
GROUP BY company;

-- View materializada para aging de payables
CREATE OR REPLACE VIEW fin_aging_pagar AS
SELECT
  company,
  COUNT(*) FILTER (WHERE data_vencimento >= CURRENT_DATE) as a_vencer_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE data_vencimento >= CURRENT_DATE), 0) as a_vencer_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 1 AND 30) as vencido_1_30_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 1 AND 30), 0) as vencido_1_30_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 31 AND 60) as vencido_31_60_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 31 AND 60), 0) as vencido_31_60_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 61 AND 90) as vencido_61_90_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento BETWEEN 61 AND 90), 0) as vencido_61_90_valor,
  COUNT(*) FILTER (WHERE CURRENT_DATE - data_vencimento > 90) as vencido_90_plus_qtd,
  COALESCE(SUM(saldo) FILTER (WHERE CURRENT_DATE - data_vencimento > 90), 0) as vencido_90_plus_valor
FROM fin_contas_pagar
WHERE status_titulo IN ('ABERTO','VENCIDO','PARCIAL')
GROUP BY company;

-- Fluxo de caixa diário (view)
CREATE OR REPLACE VIEW fin_fluxo_caixa_diario AS
SELECT
  company,
  d::date as data,
  COALESCE(SUM(cr.valor_documento) FILTER (WHERE cr.data_vencimento = d::date AND cr.status_titulo IN ('ABERTO','PARCIAL')), 0) as entradas_previstas,
  COALESCE(SUM(cr.valor_recebido) FILTER (WHERE cr.data_recebimento = d::date), 0) as entradas_realizadas,
  COALESCE(SUM(cp.valor_documento) FILTER (WHERE cp.data_vencimento = d::date AND cp.status_titulo IN ('ABERTO','PARCIAL')), 0) as saidas_previstas,
  COALESCE(SUM(cp.valor_pago) FILTER (WHERE cp.data_pagamento = d::date), 0) as saidas_realizadas
FROM generate_series(CURRENT_DATE - interval '90 days', CURRENT_DATE + interval '90 days', '1 day') d
CROSS JOIN (SELECT DISTINCT company FROM fin_contas_receber UNION SELECT DISTINCT company FROM fin_contas_pagar) companies(company)
LEFT JOIN fin_contas_receber cr ON cr.company = companies.company AND (cr.data_vencimento = d::date OR cr.data_recebimento = d::date)
LEFT JOIN fin_contas_pagar cp ON cp.company = companies.company AND (cp.data_vencimento = d::date OR cp.data_pagamento = d::date)
GROUP BY companies.company, d::date;

-- RLS
ALTER TABLE fin_categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_contas_correntes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_contas_pagar ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_contas_receber ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_dre_snapshots ENABLE ROW LEVEL SECURITY;

-- Policies: apenas admin e manager podem ver dados financeiros
CREATE POLICY "fin_categorias_select" ON fin_categorias FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_cc_select" ON fin_contas_correntes FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_cp_select" ON fin_contas_pagar FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_cr_select" ON fin_contas_receber FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_mov_select" ON fin_movimentacoes FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY "fin_dre_select" ON fin_dre_snapshots FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);

-- Service role pode tudo (para edge functions)
CREATE POLICY "fin_categorias_service" ON fin_categorias FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_cc_service" ON fin_contas_correntes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_cp_service" ON fin_contas_pagar FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_cr_service" ON fin_contas_receber FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_mov_service" ON fin_movimentacoes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_dre_service" ON fin_dre_snapshots FOR ALL USING (auth.role() = 'service_role');
