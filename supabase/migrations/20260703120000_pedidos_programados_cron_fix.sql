-- FIX do cron dos pedidos programados — substitui a 20260703091000 (que NÃO deve ser
-- aplicada): aquela versão consultava vault.decrypted_secrets por 'project_url' e
-- 'service_role_key' (nomes que NÃO existem neste vault — só CRON_SECRET) e usava a
-- coluna errada ('value' em vez de 'decrypted_secret'). Registraria o job normalmente
-- e falharia SILENCIOSO toda manhã na execução do net.http_post (url NULL).
-- Este fix usa o padrão CANÔNICO dos crons deste projeto (conferido em cron.job de
-- produção em 2026-07-03): URL fixa do projeto + header x-cron-secret do vault.
-- Idempotente: unschedule condicional antes de re-agendar (re-apply seguro).
SELECT cron.unschedule('pedidos-programados-diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pedidos-programados-diario');

SELECT cron.schedule(
  'pedidos-programados-diario',
  '0 9 * * 1-6',  -- 06:00 BRT, seg–sáb (padrão do repo)
  $$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/pedido-programado-enviar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
