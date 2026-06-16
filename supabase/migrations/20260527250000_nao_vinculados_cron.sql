-- Cron noturno: refresh do relatório de clientes não-vinculados (Oben).
-- start_nao_vinculados é ASSÍNCRONO (EdgeRuntime.waitUntil + 202), então o timeout só
-- precisa cobrir o 202 imediato — o run em si continua em background no edge.
-- ⚠️ timeout_milliseconds EXPLÍCITO (o default de 5s do pg_net mataria HTTP >5s silenciosamente
--    e o job_run_details mentiria "succeeded" — incidente já registrado no CLAUDE.md §5).
-- cron.schedule faz upsert por nome → idempotente.

SELECT cron.schedule(
  'nao-vinculados-refresh-diario',
  '30 8 * * *',  -- 08:30 UTC ≈ 05:30 BRT (fora do pico)
  $$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('action', 'start_nao_vinculados', 'account', 'vendas'),
    timeout_milliseconds := 60000
  );
  $$
);

SELECT 'CRON OK' AS status,
  (SELECT count(*) FROM cron.job WHERE jobname = 'nao-vinculados-refresh-diario') AS jobs;
-- esperado: jobs=1
