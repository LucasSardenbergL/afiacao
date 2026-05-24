-- ============================================================
-- A1 — Snapshots de projeção, alertas, config
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_projecao_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  cenario         text NOT NULL CHECK (cenario IN ('realista','otimista','pessimista')),
  horizon_weeks   integer NOT NULL DEFAULT 13,
  dados           jsonb NOT NULL,
  ncg             numeric(15,2),
  capital_giro_proprio numeric(15,2),
  saldo_tesouraria numeric(15,2),
  dias_cobertura  numeric(10,2),
  premissas       jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS fin_proj_company_snap_idx
  ON fin_projecao_snapshots (company, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS fin_proj_cenario_idx
  ON fin_projecao_snapshots (cenario, snapshot_at DESC);

ALTER TABLE fin_projecao_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_proj_select_staff ON fin_projecao_snapshots
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

-- Escrita só via edge function (SECURITY DEFINER) ou service_role.
-- Nenhuma policy de INSERT/UPDATE/DELETE para usuários.

COMMENT ON TABLE fin_projecao_snapshots IS
  'Snapshot diário (via cron) da projeção 13s + NCG + indicadores. Permite trend e comparação histórica.';

-- ============================================================

CREATE TABLE IF NOT EXISTS fin_alertas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  tipo            text NOT NULL,
  severidade      text NOT NULL CHECK (severidade IN ('info','aviso','critico')),
  mensagem        text NOT NULL,
  valor           numeric(15,2),
  threshold       numeric(15,2),
  contexto        jsonb,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  dismissed_at    timestamptz,
  dismissed_by    uuid REFERENCES auth.users(id),
  dismissed_until timestamptz
);

CREATE INDEX IF NOT EXISTS fin_alertas_company_criado_idx
  ON fin_alertas (company, criado_em DESC) WHERE dismissed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fin_alertas_unique_ativo
  ON fin_alertas (company, tipo) WHERE dismissed_at IS NULL;

ALTER TABLE fin_alertas ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_alertas_select_staff ON fin_alertas
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_alertas_update_staff ON fin_alertas
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

COMMENT ON TABLE fin_alertas IS
  'Alertas avaliados pela engine. UNIQUE em (company, tipo) WHERE dismissed_at IS NULL evita spam.';

-- ============================================================

CREATE TABLE IF NOT EXISTS fin_config_cashflow (
  company         text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  overrides_cenario jsonb NOT NULL DEFAULT '{
    "otimista":   {"recebimento_no_prazo_pct_delta": 10, "inadimplencia_pct_delta": -50},
    "pessimista": {"recebimento_no_prazo_pct_delta": -15, "inadimplencia_pct_delta": 50}
  }'::jsonb,
  thresholds      jsonb NOT NULL DEFAULT '{
    "caixa_negativo_semanas": 4,
    "ncg_deficit_alerta": 0,
    "dias_cobertura_min": 30,
    "inadimplencia_max_pct": 10,
    "concentracao_top1_max_pct": 20,
    "pmr_crescimento_max_pct_90d": 15
  }'::jsonb,
  adiantamento_categorias_codigos text[] NOT NULL DEFAULT '{}'::text[],
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id)
);

ALTER TABLE fin_config_cashflow ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_config_select_staff ON fin_config_cashflow
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_config_write_master ON fin_config_cashflow
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );

-- Seed: 3 linhas com defaults pra cada empresa
INSERT INTO fin_config_cashflow (company) VALUES
  ('oben'), ('colacor'), ('colacor_sc')
ON CONFLICT (company) DO NOTHING;

COMMENT ON TABLE fin_config_cashflow IS
  'Config por empresa: thresholds de alertas + overrides de cenário + categorias de adiantamento.';
