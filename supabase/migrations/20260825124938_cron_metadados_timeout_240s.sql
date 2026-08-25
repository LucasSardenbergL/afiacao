-- ============================================================
-- omie-sync-metadados-daily (jobid 32) — teto 150000 → 240000 ms
--
-- POR QUE: a edge `omie-sync-metadados` é SÍNCRONA (zero `waitUntil`, zero 202)
-- e percorre as duas contas em SEQUÊNCIA (`for (const acct of accounts)`,
-- index.ts:239), respondendo só depois das duas. Logo o `timeout_milliseconds`
-- cobre o TRABALHO de verdade — não é o caso do #2012 (cron 155), onde a edge
-- responde 202 e o teto não mede nada.
--
-- MEDIDO em prod 2026-08-25 (`net._http_response` id=59887 + `public.sync_state`):
--   pg_net enviou           08:30:01.998803
--   kill de 150,004s em     08:32:32.003
--   products_metadados/oben    complete 08:31:34.323  (~92s)
--   products_metadados/colacor complete 08:32:39.132  (~157s)  ← 7,1s DEPOIS do kill
-- O trabalho terminou porque o isolate Deno sobrevive ao disconnect do cliente —
-- comportamento documentado como ACIDENTAL/não-garantido pela plataforma
-- (docs/agent/sync.md). Hoje o sync do catálogo depende disso.
--
-- POR QUE NINGUÉM VIU: `cron.job_run_details` diz `succeeded` (só o enqueue),
-- `net._http_response.timed_out` fica NULL no estouro (#2015), a edge grava
-- `sync_state.status` hard-coded 'complete', e o vigia de frescor (SLA 30h) vê
-- `last_sync_at` avançando. O único lugar onde aparece é `error_msg` — retenção ~6h.
--
-- NÚMERO: 240000 = ~1,5× os 157s medidos (83s de folga ≈ +4.000 produtos ao
-- ritmo de ~2s/página de 100), e bem abaixo do wall-clock ~400s do isolate.
--
-- `cron.schedule` faz UPSERT por nome → idempotente e PRESERVA o jobid 32
-- (unschedule+schedule trocaria o jobid). url/headers/body vão VERBATIM da prod:
-- só o timeout muda.
-- ============================================================

SELECT cron.schedule(
  'omie-sync-metadados-daily',
  '30 8 * * *',
  $cron$
SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-metadados',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"accounts":["vendas","colacor_vendas"]}'::jsonb,timeout_milliseconds:=240000);
$cron$
);
