-- Fix sistêmico: 13 crons sem timeout_milliseconds explícito → pg_net usava o DEFAULT de 5s.
-- Qualquer função que leva >5s era ABORTADA aos 5s e a edge cancelada antes de gravar, enquanto
-- cron.job_run_details mostrava "succeeded" (só registra o enqueue do net.http_post). Falha
-- silenciosa de uma classe inteira de jobs. Descoberto via o incidente do calculate-scores
-- (2026-05-27), cujo cron daily-calculate-scores tinha o mesmo bug (corrigido em migration própria).
--
-- Fix: re-agenda cada um com timeout_milliseconds := 150000 (teto de wall-clock da edge — nunca
-- aborta antes do limite da própria função). cron.schedule faz upsert por nome (idempotente).
-- Comandos preservados verbatim do banco, só adicionando o timeout. sayerlack-portal-watchdog
-- (~350ms, */5) não era bomba, mas ganha o timeout por uniformidade/segurança.

-- 1) carteira-positivacao-snapshot-mensal
SELECT cron.schedule('carteira-positivacao-snapshot-mensal', '0 8 1 * *', $cron$
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-positivacao-snapshot',
  headers := jsonb_build_object('x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  timeout_milliseconds := 150000
);
$cron$);

-- 2) carteira-rebuild-nightly
SELECT cron.schedule('carteira-rebuild-nightly', '30 7 * * *', $cron$
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-rebuild',
  headers := jsonb_build_object('x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  timeout_milliseconds := 150000
);
$cron$);

-- 3) compute-association-rules-daily
SELECT cron.schedule('compute-association-rules-daily', '30 7 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"action": "compute_association_rules"}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 4) compute-costs-daily
SELECT cron.schedule('compute-costs-daily', '0 7 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"action": "compute_costs"}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 5) monthly-tool-report
SELECT cron.schedule('monthly-tool-report', '0 9 1 * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/monthly-report',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"send_email": true}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 6) omie-sync-metadados-daily
SELECT cron.schedule('omie-sync-metadados-daily', '30 8 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-metadados',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"accounts":["vendas","colacor_vendas"]}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 7) omie-sync-status-produtos-diario
SELECT cron.schedule('omie-sync-status-produtos-diario', '30 6 * * *', $cron$
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-status-produtos',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('empresa', 'ALL'),
  timeout_milliseconds := 150000
);
$cron$);

-- 8) process-recurring-orders-daily
SELECT cron.schedule('process-recurring-orders-daily', '0 7 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/process-recurring-orders',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 9) sayerlack-portal-watchdog (fast ~350ms; timeout por uniformidade)
SELECT cron.schedule('sayerlack-portal-watchdog', '*/5 * * * *', $cron$
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/enviar-pedido-portal-sayerlack',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('watchdog', true, 'minutos', 5),
  timeout_milliseconds := 150000
);
$cron$);

-- 10) sync-colacor-vendas-products
SELECT cron.schedule('sync-colacor-vendas-products', '15 6 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"action": "sync_products", "account": "colacor_vendas", "max_pages": 50}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 11) sync-reprocess-operational
SELECT cron.schedule('sync-reprocess-operational', '15 */2 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sync-reprocess',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"action": "reprocess_operational", "account": "oben"}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 12) sync-reprocess-strategic
SELECT cron.schedule('sync-reprocess-strategic', '30 2 * * *', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sync-reprocess',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"action": "reprocess_strategic", "account": "oben"}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);

-- 13) weekly-algorithm-a-audit
SELECT cron.schedule('weekly-algorithm-a-audit', '0 3 * * 0', $cron$
SELECT net.http_post(
  url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/algorithm-a-audit',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"triggered_by": "cron"}'::jsonb,
  timeout_milliseconds := 150000
);
$cron$);
