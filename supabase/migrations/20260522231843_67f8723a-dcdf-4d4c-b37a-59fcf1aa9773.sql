SELECT cron.schedule(
  'omie-sync-estoque-diario',
  '0 9 * * *',
  $$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-estoque',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body:='{"empresa": "OBEN"}'::jsonb
  );$$
);