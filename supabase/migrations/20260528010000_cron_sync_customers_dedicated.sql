-- Cron dedicado p/ o sync de clientes (vendas/oben). Contexto: o syncCustomers estava preso em
-- sync_state.customers status='running' há ~2 meses. Causa em 2 camadas: (1) N+1 (~2-3 queries/cliente
-- × ~10k) — corrigido no #435 (bulk reads + dedup + bulk upsert); (2) mesmo sem N+1, a enumeração de
-- ~10k clientes do Omie NÃO cabe no budget SÍNCRONO do request → WORKER_RESOURCE_LIMIT. Fix: a action
-- sync_customers agora roda em BACKGROUND (EdgeRuntime.waitUntil), igual o start_nao_vinculados (#383)
-- que completa o MESMO volume. Este cron isola o customers no seu próprio worker (budget de background).
--
-- customers FOI REMOVIDO do sync_all (que rodava síncrono e re-prendia o estado a cada passada) — então
-- este cron passa a ser o ÚNICO responsável pelo sync de clientes. timeout só cobre o 202 (o trabalho
-- segue em background). 0 5 = antes do batch das 6h, e antes do data-health-watchdog pegar o frescor.
-- ⚠️ Requer o redeploy do omie-analytics-sync (action sync_customers em background) ANTES de valer.

SELECT cron.schedule('sync-customers-vendas-daily', '0 5 * * *',
  $$ SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{"action":"sync_customers","account":"vendas"}'::jsonb,
    timeout_milliseconds := 60000
  ); $$);
