-- 20260708234721_sync_customers_colacor_servicos_crons.sql
-- Agenda `sync_customers` (edge omie-analytics-sync) para as contas colacor_vendas e servicos.
--
-- CONTEXTO: a proof-table omie_customer_account_map (mapa user_id→omie_codigo_cliente, lida por
-- customer360/useCustomerPreferredItems e compare-customer-process) só se mantinha fresca na conta
-- `vendas` (oben), via o cron sync-customers-vendas-daily (0 5). colacor_vendas (→colacor) e
-- servicos (→colacor_sc) foram populadas UMA vez, manualmente, e ficavam ESTÁTICAS — cliente novo
-- dessas empresas não entrava na proof-table até um sync manual. Estes 2 crons fecham essa lacuna.
--
-- SEGURANÇA (Fatia 4, PR #1254): o handler syncCustomers gate as escritas legadas do espelho
-- omie_clientes + tags cliente_classificacao APENAS para account==='vendas'. Rodar colacor_vendas/
-- servicos escreve SÓ a proof-table (document-first) — não toca o espelho velho. Seguro.
--
-- ESCALONAMENTO (anti-concorrência): cada sync enumera ~10k clientes e a edge processa em waitUntil
-- (background, responde 202). 3 invocações pesadas simultâneas da MESMA edge arriscam
-- WORKER_RESOURCE_LIMIT. Duração real medida (span do updated_at): ~1-2 min/conta. Horários
-- espaçados 20 min (~10x folga), na janela 05:00-06:00 que só tem estes syncs batendo na edge:
--   vendas 0 5 (existente, NÃO tocado)  →  colacor_vendas 20 5  →  servicos 40 5  →  (sync_all vendas 0 6).
--
-- net.http_post SÓ ENFILEIRA; a edge responde 202 e roda em background. timeout_milliseconds
-- EXPLÍCITO (default 5s mata silencioso — CLAUDE.md/sync.md); 60000 replica o irmão vendas (104).
-- Verdade HTTP vive em net._http_response, NÃO em cron.job_run_details (que só prova o ENQUEUE).
--
-- Idempotente: unschedule antes de re-agendar (cron.schedule já é upsert por nome; o unschedule
-- limpa estado zumbi). Re-colar = no-op.

-- ============================================================
-- 1) colacor_vendas → grava company `colacor` na proof-table
-- ============================================================
DO $do$
BEGIN
  PERFORM cron.unschedule('sync-customers-colacor-vendas-daily');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'sync-customers-colacor-vendas-daily',
  '20 5 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{"action":"sync_customers","account":"colacor_vendas"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

-- ============================================================
-- 2) servicos → grava company `colacor_sc` na proof-table
-- ============================================================
DO $do$
BEGIN
  PERFORM cron.unschedule('sync-customers-servicos-daily');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'sync-customers-servicos-daily',
  '40 5 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{"action":"sync_customers","account":"servicos"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);
