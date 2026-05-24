SELECT cron.schedule(
  'omie-sync-estoque-diario',
  '0 9 * * *',
  $$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-estoque',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='SERVICE_ROLE_KEY' LIMIT 1)
    ),
    body:='{"empresa": "OBEN"}'::jsonb
  );$$
);