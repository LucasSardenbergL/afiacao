-- Cron diário: cobre o catálogo OBEN (conta vendas) com cExibeTodos:S pra popular o CMC em
-- inventory_position. Roda 04:00 (madrugada, fora do pico). O edge responde 202 e processa em
-- background (waitUntil) — timeout curto do net.http_post só cobre o ACK, não o processamento.
-- Idempotente (upsert por nome). Mantém o sync de saldo de 30 min (sync-inventory-vendas-30m) intacto.
SELECT cron.schedule(
  'sync-inventory-full-vendas-daily',
  '0 4 * * *',
  $$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_inventory_full", "account": "vendas"}'::jsonb,
    timeout_milliseconds := 60000
  );$$
);

-- Validação:
SELECT 'CRON_INV_FULL' AS bloco,
  (SELECT count(*) FROM cron.job WHERE jobname = 'sync-inventory-full-vendas-daily') AS cron_criado; -- esperado 1
