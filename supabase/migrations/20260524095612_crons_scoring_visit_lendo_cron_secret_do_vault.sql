-- ============================================================
-- Fix 401 sistêmico nos crons: tirar CRON_SECRET hardcoded de 2 crons
--
-- scoring-recalc-batch-nightly e visit-score-recalc-batch-nightly
-- mandavam o secret literal '68c9fc14...' no header x-cron-secret.
-- Todos os outros crons leem do Vault (name='CRON_SECRET'). Após a
-- rotação do CRON_SECRET (Vault + env var das edge functions), estes 2
-- continuariam 401 enquanto carregassem o valor antigo na unha.
--
-- Aqui eles passam a ler do Vault, virando fonte única e sem drift.
-- cron.schedule faz upsert por nome → idempotente, pode rerodar.
--
-- ⚠️ Pré-requisito (operacional, NÃO neste arquivo): o Vault CRON_SECRET
-- e a env var CRON_SECRET das edge functions já devem estar com o MESMO
-- valor novo. Ver paste-block do Vault + instrução do Lovable no PR.
-- ============================================================

SELECT cron.schedule(
  'scoring-recalc-batch-nightly',
  '0 6 * * *',
  $$SELECT net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/scoring-recalc-batch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
      ),
      timeout_milliseconds := 55000
  );$$
);

SELECT cron.schedule(
  'visit-score-recalc-batch-nightly',
  '0 7 * * *',
  $$SELECT net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/visit-score-recalc-batch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
      ),
      timeout_milliseconds := 55000
  );$$
);
