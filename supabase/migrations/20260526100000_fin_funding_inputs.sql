-- supabase/migrations/20260526100000_fin_funding_inputs.sql
-- Custo Marginal de Funding: taxas default das fontes por empresa, TABELA master-only.
-- O engine fin-funding usa service_role (bypassa RLS); o app só lê/escreve como master. Idempotente.

CREATE TABLE IF NOT EXISTS fin_funding_inputs (
  company        text PRIMARY KEY,
  funding_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

COMMENT ON COLUMN fin_funding_inputs.funding_inputs IS
  'Funding: { fontes: { antecipacao: {taxa_desconto_mensal_perc, tarifa_fixa, tipo: desconto|factoring, coobrigacao, ativo}, capital_giro: {cet_anual_perc, ativo}, cheque_especial: {cet_anual_perc, ativo} }, reserva_dias_min, gap_estrutural_semanas_min }';

ALTER TABLE fin_funding_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_funding_inputs_select_master ON fin_funding_inputs;
CREATE POLICY fin_funding_inputs_select_master ON fin_funding_inputs
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_funding_inputs_write_master ON fin_funding_inputs;
CREATE POLICY fin_funding_inputs_write_master ON fin_funding_inputs
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

INSERT INTO fin_funding_inputs (company) VALUES ('colacor'), ('oben'), ('colacor_sc')
  ON CONFLICT (company) DO NOTHING;

SELECT 'fin_funding_inputs OK' AS status,
  (SELECT count(*) FROM fin_funding_inputs) AS linhas,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_funding_inputs') AS policies;
