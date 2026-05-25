-- ============================================================
-- Tuning de crons (2026-05-24, follow-up #3 da auditoria de crons):
--   (a) estoque 1x/dia → 3x/dia (intra-day p/ distribuidora)
--   (b) timeout_milliseconds explícito nos syncs Omie que rodavam no default
--       5s do pg_net → o pg_net marcava timeout mesmo a função completando
--       depois (cosmético, mas sujava net._http_response e o diagnóstico).
--
-- cron.schedule = upsert por nome → idempotente. Comandos reconstruídos a
-- partir do estado vivo (cron.job) + timeout adicionado.
-- ============================================================

-- (a) Estoque OBEN: 3x/dia (09h/14h/19h UTC = 06h/11h/16h BRT) + timeout.
SELECT cron.schedule(
  'omie-sync-estoque-diario',
  '0 9,14,19 * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-estoque',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"empresa": "OBEN"}'::jsonb,
    timeout_milliseconds := 90000
  );$cron$
);

-- (b) Timeout explícito nos syncs Omie (mantêm schedule e body atuais).
SELECT cron.schedule(
  'sync-orders-vendas-2h',
  '0 */2 * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_orders", "account": "vendas"}'::jsonb,
    timeout_milliseconds := 120000
  );$cron$
);

SELECT cron.schedule(
  'sync-products-customers-daily',
  '0 6 * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_all", "account": "vendas"}'::jsonb,
    timeout_milliseconds := 120000
  );$cron$
);

SELECT cron.schedule(
  'sync-inventory-vendas-30m',
  '*/30 * * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_inventory", "account": "vendas"}'::jsonb,
    timeout_milliseconds := 60000
  );$cron$
);

SELECT cron.schedule(
  'sync-omie-services-hourly',
  '0 * * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_services"}'::jsonb,
    timeout_milliseconds := 60000
  );$cron$
);
