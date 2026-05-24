-- ============================================================
-- MÓDULO FINANCEIRO v2: 6 frentes de evolução
-- ============================================================

-- ═══════════════ 1. FECHAMENTO MENSAL ═══════════════

CREATE TABLE IF NOT EXISTS fin_fechamentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ano integer NOT NULL,
  mes integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','em_revisao','fechado','reaberto')),
  versao integer NOT NULL DEFAULT 1,
  -- Snapshot congelado no momento do fechamento
  snapshot_dre_id uuid REFERENCES fin_dre_snapshots(id),
  snapshot_data jsonb DEFAULT '{}',
  -- Audit trail
  fechado_por uuid,
  fechado_em timestamptz,
  aprovado_por uuid,
  aprovado_em timestamptz,
  reaberto_por uuid,
  reaberto_em timestamptz,
  motivo_reabertura text,
  notas text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, ano, mes, versao)
);

CREATE INDEX idx_fin_fech_company_periodo ON fin_fechamentos(company, ano, mes);
CREATE INDEX idx_fin_fech_status ON fin_fechamentos(status);

-- Histórico de ações no fechamento
CREATE TABLE IF NOT EXISTS fin_fechamento_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fechamento_id uuid NOT NULL REFERENCES fin_fechamentos(id) ON DELETE CASCADE,
  acao text NOT NULL CHECK (acao IN ('criar','revisar','fechar','aprovar','reabrir','comentar')),
  usuario_id uuid,
  usuario_nome text,
  detalhes jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_fin_fech_log_fech ON fin_fechamento_log(fechamento_id);

-- ═══════════════ 2. CONCILIAÇÃO BANCÁRIA ═══════════════

CREATE TABLE IF NOT EXISTS fin_conciliacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_ncodcc bigint NOT NULL,
  -- Movimento bancário (extrato)
  mov_id uuid REFERENCES fin_movimentacoes(id),
  mov_data date,
  mov_valor numeric(15,2),
  mov_descricao text,
  -- Título vinculado (CR ou CP)
  tipo_titulo text CHECK (tipo_titulo IN ('CR','CP')),
  titulo_id uuid,
  titulo_valor numeric(15,2),
  -- Status da conciliação
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','conciliado','divergencia','ignorado')),
  tipo_match text CHECK (tipo_match IN ('automatico','manual','parcial')),
  diferenca numeric(15,2) GENERATED ALWAYS AS (COALESCE(mov_valor, 0) - COALESCE(titulo_valor, 0)) STORED,
  -- Resolução
  resolvido_por uuid,
  resolvido_em timestamptz,
  observacao text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_fin_conc_company ON fin_conciliacao(company, omie_ncodcc);
CREATE INDEX idx_fin_conc_status ON fin_conciliacao(status);
CREATE INDEX idx_fin_conc_mov ON fin_conciliacao(mov_id);

-- ═══════════════ 3. CONSOLIDAÇÃO INTERCOMPANY ═══════════════

-- Regras de eliminação entre empresas
CREATE TABLE IF NOT EXISTS fin_eliminacoes_intercompany (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem text NOT NULL CHECK (empresa_origem IN ('oben','colacor','colacor_sc')),
  empresa_destino text NOT NULL CHECK (empresa_destino IN ('oben','colacor','colacor_sc')),
  tipo text NOT NULL CHECK (tipo IN ('receita_despesa','cr_cp','transferencia')),
  -- Critério de match
  match_por text NOT NULL DEFAULT 'cnpj' CHECK (match_por IN ('cnpj','categoria','documento','manual')),
  cnpj_origem text,
  cnpj_destino text,
  categoria_origem text,
  categoria_destino text,
  descricao text NOT NULL,
  ativo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CHECK (empresa_origem != empresa_destino)
);

-- Log de eliminações aplicadas por período
CREATE TABLE IF NOT EXISTS fin_eliminacoes_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_id uuid REFERENCES fin_eliminacoes_intercompany(id),
  ano integer NOT NULL,
  mes integer NOT NULL,
  valor_eliminado numeric(15,2) NOT NULL,
  qtd_titulos integer DEFAULT 0,
  detalhes jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_fin_elim_log_periodo ON fin_eliminacoes_log(ano, mes);

-- ═══════════════ 4. ORÇADO VS REALIZADO + FORECAST ═══════════════

CREATE TABLE IF NOT EXISTS fin_orcamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ano integer NOT NULL,
  mes integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  dre_linha text NOT NULL,
  valor_orcado numeric(15,2) NOT NULL DEFAULT 0,
  notas text,
  criado_por uuid,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, ano, mes, dre_linha)
);

CREATE INDEX idx_fin_orc_periodo ON fin_orcamento(company, ano, mes);

-- Forecast rolling (projeções mensais atualizáveis)
CREATE TABLE IF NOT EXISTS fin_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  tipo text NOT NULL CHECK (tipo IN ('caixa','dre')),
  ano integer NOT NULL,
  mes integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  dre_linha text, -- null para tipo=caixa
  valor_forecast numeric(15,2) NOT NULL DEFAULT 0,
  metodo text DEFAULT 'manual' CHECK (metodo IN ('manual','media_movel','tendencia','ia')),
  base_meses integer, -- quantos meses de base no cálculo
  confianca numeric(5,2), -- 0-100
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, tipo, ano, mes, COALESCE(dre_linha, '_'))
);

-- ═══════════════ 5. DIMENSÕES ANALÍTICAS ═══════════════

-- Tabela de dimensões para análise multidimensional
-- Já temos categoria, departamento, centro_custo em CR/CP
-- Adicionamos views materializadas para performance

CREATE MATERIALIZED VIEW IF NOT EXISTS fin_analise_cr_dimensoes AS
SELECT
  company,
  EXTRACT(YEAR FROM data_vencimento)::integer AS ano,
  EXTRACT(MONTH FROM data_vencimento)::integer AS mes,
  categoria_codigo,
  categoria_descricao,
  departamento,
  centro_custo,
  vendedor_id,
  nome_cliente,
  cnpj_cpf,
  status_titulo,
  COUNT(*) AS qtd_titulos,
  SUM(valor_documento) AS total_documento,
  SUM(valor_recebido) AS total_recebido,
  SUM(saldo) AS total_saldo
FROM fin_contas_receber
WHERE data_vencimento IS NOT NULL
GROUP BY company, EXTRACT(YEAR FROM data_vencimento), EXTRACT(MONTH FROM data_vencimento),
  categoria_codigo, categoria_descricao, departamento, centro_custo,
  vendedor_id, nome_cliente, cnpj_cpf, status_titulo;

CREATE MATERIALIZED VIEW IF NOT EXISTS fin_analise_cp_dimensoes AS
SELECT
  company,
  EXTRACT(YEAR FROM data_vencimento)::integer AS ano,
  EXTRACT(MONTH FROM data_vencimento)::integer AS mes,
  categoria_codigo,
  categoria_descricao,
  departamento,
  centro_custo,
  nome_fornecedor,
  cnpj_cpf,
  tipo_documento,
  status_titulo,
  COUNT(*) AS qtd_titulos,
  SUM(valor_documento) AS total_documento,
  SUM(valor_pago) AS total_pago,
  SUM(saldo) AS total_saldo
FROM fin_contas_pagar
WHERE data_vencimento IS NOT NULL
GROUP BY company, EXTRACT(YEAR FROM data_vencimento), EXTRACT(MONTH FROM data_vencimento),
  categoria_codigo, categoria_descricao, departamento, centro_custo,
  nome_fornecedor, cnpj_cpf, tipo_documento, status_titulo;

-- Refresh function (chamada após sync)
CREATE OR REPLACE FUNCTION fin_refresh_analise_dimensoes()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY fin_analise_cr_dimensoes;
  REFRESH MATERIALIZED VIEW CONCURRENTLY fin_analise_cp_dimensoes;
EXCEPTION WHEN OTHERS THEN
  -- Concurrently requires unique index, fallback to full refresh
  REFRESH MATERIALIZED VIEW fin_analise_cr_dimensoes;
  REFRESH MATERIALIZED VIEW fin_analise_cp_dimensoes;
END;
$$;

-- Unique indexes for CONCURRENTLY refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_analise_cr_unique ON fin_analise_cr_dimensoes(
  company, ano, mes, COALESCE(categoria_codigo,''), COALESCE(departamento,''),
  COALESCE(centro_custo,''), COALESCE(vendedor_id::text,''), COALESCE(nome_cliente,''),
  COALESCE(cnpj_cpf,''), status_titulo
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_analise_cp_unique ON fin_analise_cp_dimensoes(
  company, ano, mes, COALESCE(categoria_codigo,''), COALESCE(departamento,''),
  COALESCE(centro_custo,''), COALESCE(nome_fornecedor,''), COALESCE(cnpj_cpf,''),
  COALESCE(tipo_documento,''), status_titulo
);

-- ═══════════════ 6. PERMISSÕES FINANCEIRAS GRANULARES ═══════════════

CREATE TABLE IF NOT EXISTS fin_permissoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  perfil text NOT NULL CHECK (perfil IN ('analista','gerente','controller','cfo')),
  -- Escopo de empresas visíveis
  empresas text[] NOT NULL DEFAULT ARRAY['oben','colacor','colacor_sc'],
  -- Permissões específicas
  pode_sync boolean DEFAULT false,
  pode_fechar_mes boolean DEFAULT false,
  pode_aprovar_fechamento boolean DEFAULT false,
  pode_reabrir_fechamento boolean DEFAULT false,
  pode_editar_orcamento boolean DEFAULT false,
  pode_editar_mapping boolean DEFAULT false,
  pode_eliminar_intercompany boolean DEFAULT false,
  pode_conciliar boolean DEFAULT false,
  pode_exportar boolean DEFAULT true,
  pode_ver_dre boolean DEFAULT true,
  pode_ver_todas_empresas boolean DEFAULT false,
  -- Audit
  concedido_por uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- Defaults por perfil (referência, não enforcement)
COMMENT ON TABLE fin_permissoes IS '
Perfis padrão:
- analista: pode_exportar, pode_ver_dre, pode_conciliar. Vê empresa(s) atribuída(s).
- gerente: tudo do analista + pode_sync, pode_fechar_mes, pode_editar_mapping. Vê empresa(s) atribuída(s).
- controller: tudo do gerente + pode_aprovar_fechamento, pode_editar_orcamento, pode_eliminar_intercompany, pode_ver_todas_empresas.
- cfo: tudo. Inclui pode_reabrir_fechamento.
';

-- ═══════════════ OBSERVABILIDADE DO SYNC ═══════════════

-- Adicionar campos de métricas ao sync_log
ALTER TABLE fin_sync_log
  ADD COLUMN IF NOT EXISTS duracao_ms integer,
  ADD COLUMN IF NOT EXISTS entidades_por_empresa jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS api_calls integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rate_limits_hit integer DEFAULT 0;

-- ═══════════════ KPIs TRIBUTÁRIOS ═══════════════

CREATE TABLE IF NOT EXISTS fin_kpi_tributario (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ano integer NOT NULL,
  mes integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  regime text NOT NULL, -- 'simples', 'presumido', 'real'
  receita_bruta_acumulada numeric(15,2) DEFAULT 0, -- 12 meses para faixa SN
  aliquota_efetiva numeric(8,4) DEFAULT 0,
  carga_tributaria_total numeric(15,2) DEFAULT 0,
  -- Simples Nacional
  faixa_sn text,
  fator_r numeric(8,4), -- folha/receita para anexo V
  -- Lucro Presumido
  base_presuncao_servico numeric(15,2) DEFAULT 0,
  base_presuncao_comercio numeric(15,2) DEFAULT 0,
  irpj numeric(15,2) DEFAULT 0,
  csll numeric(15,2) DEFAULT 0,
  pis numeric(15,2) DEFAULT 0,
  cofins numeric(15,2) DEFAULT 0,
  iss numeric(15,2) DEFAULT 0,
  icms numeric(15,2) DEFAULT 0,
  -- Drivers
  detalhamento jsonb DEFAULT '{}',
  calculated_at timestamptz DEFAULT now(),
  UNIQUE(company, ano, mes)
);

CREATE INDEX idx_fin_kpi_trib_periodo ON fin_kpi_tributario(company, ano, mes);

-- ═══════════════ RLS PARA NOVAS TABELAS ═══════════════

ALTER TABLE fin_fechamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_fechamento_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_conciliacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_eliminacoes_intercompany ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_eliminacoes_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_orcamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_permissoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_kpi_tributario ENABLE ROW LEVEL SECURITY;

-- Service role (edge functions)
CREATE POLICY "fin_fechamentos_service" ON fin_fechamentos FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_fechamento_log_service" ON fin_fechamento_log FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_conciliacao_service" ON fin_conciliacao FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_elim_service" ON fin_eliminacoes_intercompany FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_elim_log_service" ON fin_eliminacoes_log FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_orc_service" ON fin_orcamento FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_forecast_service" ON fin_forecast FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_perm_service" ON fin_permissoes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_kpi_trib_service" ON fin_kpi_tributario FOR ALL USING (auth.role() = 'service_role');

-- User access via fin_permissoes (granular)
-- Select: precisa ter registro em fin_permissoes OU ser admin/manager legacy
CREATE OR REPLACE FUNCTION fin_user_can_access(check_company text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
DECLARE
  v_perm RECORD;
BEGIN
  -- Legacy: admin/manager sempre tem acesso
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager')) THEN
    RETURN true;
  END IF;
  -- Granular: fin_permissoes
  SELECT * INTO v_perm FROM fin_permissoes WHERE user_id = auth.uid();
  IF v_perm IS NULL THEN RETURN false; END IF;
  IF check_company IS NULL THEN RETURN true; END IF;
  RETURN v_perm.pode_ver_todas_empresas OR check_company = ANY(v_perm.empresas);
END;
$$;

-- Apply to all financial tables
CREATE POLICY "fin_fechamentos_user" ON fin_fechamentos FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY "fin_fechamento_log_user" ON fin_fechamento_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM fin_fechamentos f WHERE f.id = fechamento_id AND fin_user_can_access(f.company))
);
CREATE POLICY "fin_conciliacao_user" ON fin_conciliacao FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY "fin_elim_user" ON fin_eliminacoes_intercompany FOR SELECT USING (fin_user_can_access());
CREATE POLICY "fin_elim_log_user" ON fin_eliminacoes_log FOR SELECT USING (fin_user_can_access());
CREATE POLICY "fin_orc_user" ON fin_orcamento FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY "fin_forecast_user" ON fin_forecast FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY "fin_perm_user" ON fin_permissoes FOR SELECT USING (user_id = auth.uid() OR fin_user_can_access());
CREATE POLICY "fin_kpi_trib_user" ON fin_kpi_tributario FOR SELECT USING (fin_user_can_access(company));

-- Write policies via fin_permissoes checks
CREATE POLICY "fin_orc_write" ON fin_orcamento FOR ALL USING (
  EXISTS (SELECT 1 FROM fin_permissoes WHERE user_id = auth.uid() AND pode_editar_orcamento)
);
CREATE POLICY "fin_conc_write" ON fin_conciliacao FOR ALL USING (
  EXISTS (SELECT 1 FROM fin_permissoes WHERE user_id = auth.uid() AND pode_conciliar)
);
CREATE POLICY "fin_elim_write" ON fin_eliminacoes_intercompany FOR ALL USING (
  EXISTS (SELECT 1 FROM fin_permissoes WHERE user_id = auth.uid() AND pode_eliminar_intercompany)
);
CREATE POLICY "fin_fech_write" ON fin_fechamentos FOR UPDATE USING (
  EXISTS (SELECT 1 FROM fin_permissoes WHERE user_id = auth.uid() AND (pode_fechar_mes OR pode_aprovar_fechamento OR pode_reabrir_fechamento))
);
