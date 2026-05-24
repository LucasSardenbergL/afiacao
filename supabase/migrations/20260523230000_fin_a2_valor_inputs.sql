-- supabase/migrations/20260523230000_fin_a2_valor_inputs.sql
-- A2 — Retorno & Valor: inputs manuais por empresa em TABELA SEPARADA master-only.
-- Dado sensível (pró-labore/patrimônio do dono, dívida, PL, valor de ativos): NÃO pode ficar
-- em fin_config_cashflow, cuja policy de SELECT permite 'employee' ler a linha inteira.
-- O engine fin-valor-engine usa service_role (bypassa RLS); o app só lê/escreve como master.
-- Idempotente.

CREATE TABLE IF NOT EXISTS fin_valor_inputs (
  company       text PRIMARY KEY,
  valor_inputs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

COMMENT ON COLUMN fin_valor_inputs.valor_inputs IS
  'A2: { ativo_fixo:{valor,data_ref,fonte,base,operacional}, ajustes, divida, equity, kd, ke:{conservador,base,agressivo}, prolabore_real_mensal, prolabore_mercado_mensal, aluguel_mercado_mensal, intercompany_giro }';

ALTER TABLE fin_valor_inputs ENABLE ROW LEVEL SECURITY;

-- master-only: employee NÃO lê nem escreve (dado sensível do dono).
DROP POLICY IF EXISTS fin_valor_inputs_select_master ON fin_valor_inputs;
CREATE POLICY fin_valor_inputs_select_master ON fin_valor_inputs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );

DROP POLICY IF EXISTS fin_valor_inputs_write_master ON fin_valor_inputs;
CREATE POLICY fin_valor_inputs_write_master ON fin_valor_inputs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );

-- Seed: 1 linha por empresa (o app dá UPDATE; precisa da linha existir). Idempotente.
INSERT INTO fin_valor_inputs (company) VALUES ('colacor'), ('oben'), ('colacor_sc')
  ON CONFLICT (company) DO NOTHING;

-- Validação
SELECT 'A2 fin_valor_inputs OK' AS status,
  (SELECT count(*) FROM fin_valor_inputs) AS linhas,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_valor_inputs') AS policies;
