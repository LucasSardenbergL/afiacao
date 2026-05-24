-- ============================================================
-- Audit Trail Genérico para módulo Financeiro
-- Tabela única, escrita exclusivamente por trigger SECURITY DEFINER.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_audit_log (
  id              bigserial PRIMARY KEY,
  table_name      text NOT NULL,
  row_id          text NOT NULL,
  op              text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  changed_fields  jsonb NOT NULL,
  changed_by      uuid REFERENCES auth.users(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  company         text,
  origem          text NOT NULL DEFAULT 'manual'
                  CHECK (origem IN ('manual','omie_sync','edge_fn','override_emergencia','cron','trigger')),
  period_ref      date,
  override_justificativa text
);

CREATE INDEX IF NOT EXISTS fin_audit_log_table_row_idx
  ON fin_audit_log (table_name, row_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS fin_audit_log_company_period_idx
  ON fin_audit_log (company, period_ref, changed_at DESC);

CREATE INDEX IF NOT EXISTS fin_audit_log_user_idx
  ON fin_audit_log (changed_by, changed_at DESC);

COMMENT ON TABLE fin_audit_log IS
  'Trilha de auditoria do módulo financeiro. Escrita exclusivamente pelo trigger fin_audit_trigger via SECURITY DEFINER.';

-- RLS: leitura para staff, escrita bloqueada (só trigger escreve via SECURITY DEFINER)
ALTER TABLE fin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_audit_log_select_staff ON fin_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee','master')
    )
  );

-- Nenhuma policy de INSERT/UPDATE/DELETE — bloqueado por padrão com RLS habilitado.
-- O trigger fin_audit_trigger é SECURITY DEFINER e contorna RLS legitimamente.
