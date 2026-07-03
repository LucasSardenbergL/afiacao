-- Cron diário dos pedidos programados: 09:00 UTC = 06:00 BRT, seg–sáb (padrão do repo).
-- timeout_milliseconds EXPLÍCITO (default 5s mata silencioso — CLAUDE.md/sync.md).
-- Verdade HTTP em net._http_response; cron.job_run_details só prova o enqueue.
-- Idempotente: unschedule antes de re-agendar (re-apply seguro no SQL Editor).
SELECT cron.unschedule('pedidos-programados-diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pedidos-programados-diario');

SELECT cron.schedule(
  'pedidos-programados-diario',
  '0 9 * * 1-6',
  $$
  SELECT net.http_post(
    url := (SELECT value FROM vault.decrypted_secrets WHERE name = 'project_url')
           || '/functions/v1/pedido-programado-enviar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT value FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
