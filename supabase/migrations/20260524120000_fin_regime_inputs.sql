-- supabase/migrations/20260524120000_fin_regime_inputs.sql
-- Otimizador Tributário: inputs manuais por empresa em TABELA master-only.
-- Dado sensível (folha, créditos, presunções). O engine fin-regime-tributario usa
-- service_role (bypassa RLS); o app só lê/escreve como master. Idempotente.

CREATE TABLE IF NOT EXISTS fin_regime_inputs (
  company        text PRIMARY KEY,
  regime_inputs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

COMMENT ON COLUMN fin_regime_inputs.regime_inputs IS
  'Regime: { folha_cpp_anual, massa_fator_r_anual, encargo_patronal_pct, presuncao_irpj, presuncao_csll, credito_pis_cofins_estimado, receita_tributavel_pis_cofins_pct, anexo_simples }';

ALTER TABLE fin_regime_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_regime_inputs_select_master ON fin_regime_inputs;
CREATE POLICY fin_regime_inputs_select_master ON fin_regime_inputs
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_regime_inputs_write_master ON fin_regime_inputs;
CREATE POLICY fin_regime_inputs_write_master ON fin_regime_inputs
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

INSERT INTO fin_regime_inputs (company) VALUES ('colacor'), ('oben'), ('colacor_sc')
  ON CONFLICT (company) DO NOTHING;

SELECT 'fin_regime_inputs OK' AS status,
  (SELECT count(*) FROM fin_regime_inputs) AS linhas,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_regime_inputs') AS policies;
