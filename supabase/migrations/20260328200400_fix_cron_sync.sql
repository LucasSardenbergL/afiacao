-- ============================================================
-- MÓDULO FINANCEIRO: Sync automático via Supabase Scheduled Functions
-- 
-- COMO USAR (duas opções, escolha uma):
--
-- OPÇÃO A — Supabase Dashboard (recomendado):
--   Database → Extensions → habilitar pg_cron
--   SQL Editor → colar os comandos de cron.schedule abaixo
--
-- OPÇÃO B — Supabase CLI:
--   supabase functions deploy omie-financeiro
--   Configurar cron via Dashboard
-- ============================================================

-- Tabela de log de syncs
CREATE TABLE IF NOT EXISTS fin_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  companies text[],
  status text DEFAULT 'running' CHECK (status IN ('running','complete','error')),
  results jsonb DEFAULT '{}',
  error_message text,
  triggered_by text DEFAULT 'manual',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_fin_sync_log_started ON fin_sync_log(started_at DESC);

ALTER TABLE fin_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "fin_sync_log_select" ON fin_sync_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager'))
);
CREATE POLICY IF NOT EXISTS "fin_sync_log_service" ON fin_sync_log FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- CRON COMMANDS (colar no SQL Editor após habilitar pg_cron):
-- ============================================================
--
-- Sync diário, seg-sáb, 6h BRT (9h UTC):
-- SELECT cron.schedule(
--   'fin-sync-diario',
--   '0 9 * * 1-6',
--   $$
--   SELECT net.http_post(
--     url := (SELECT value FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/omie-financeiro',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (SELECT value FROM vault.decrypted_secrets WHERE name = 'service_role_key')
--     ),
--     body := '{"action":"sync_all","companies":["oben","colacor","colacor_sc"]}'::jsonb
--   );
--   $$
-- );
--
-- DRE mensal, dia 1 às 7h BRT:
-- SELECT cron.schedule(
--   'fin-dre-mensal',
--   '0 10 1 * *',
--   $$
--   SELECT net.http_post(
--     url := (SELECT value FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/omie-financeiro',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (SELECT value FROM vault.decrypted_secrets WHERE name = 'service_role_key')
--     ),
--     body := '{"action":"calcular_dre_year","companies":["oben","colacor","colacor_sc"]}'::jsonb
--   );
--   $$
-- );
--
-- SETUP vault secrets (uma vez, no SQL Editor):
-- SELECT vault.create_secret('https://SEU_PROJECT_ID.supabase.co', 'project_url');
-- SELECT vault.create_secret('SEU_SERVICE_ROLE_KEY', 'service_role_key');
--
-- Verificar crons: SELECT * FROM cron.job;
-- Remover: SELECT cron.unschedule('fin-sync-diario');
