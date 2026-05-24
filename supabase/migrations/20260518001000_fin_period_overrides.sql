-- ============================================================
-- Janelas de override de período fechado
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_period_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ano             integer NOT NULL,
  mes             integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  opened_by       uuid NOT NULL REFERENCES auth.users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  justificativa   text NOT NULL,
  acao_planejada  text NOT NULL,
  closed_at       timestamptz,
  closed_by       uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS fin_period_overrides_active_idx
  ON fin_period_overrides (company, ano, mes, expires_at)
  WHERE closed_at IS NULL;

ALTER TABLE fin_period_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_period_overrides_select_staff ON fin_period_overrides
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_period_overrides_insert_master ON fin_period_overrides
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );

CREATE POLICY fin_period_overrides_update_self ON fin_period_overrides
  FOR UPDATE USING (opened_by = auth.uid())
  WITH CHECK (opened_by = auth.uid());

COMMENT ON TABLE fin_period_overrides IS
  'Janelas de 15 min de override de período fechado, abertas por master via fin-period-override.';
