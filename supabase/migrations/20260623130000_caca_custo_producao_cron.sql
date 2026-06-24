-- 20260623130000_caca_custo_producao_cron.sql
-- Cron do custo de produção (fabricados Colacor via Estrutura/malha do Omie).
--
-- ⚠️ APLICAR POR ÚLTIMO: só DEPOIS de (1) a migration 20260623120000 (coluna+view) e (2) o DEPLOY
--    da edge omie-analytics-sync com a action `sync_custo_producao`. Se aplicar antes da edge, o cron
--    chama uma action inexistente (falha silenciosa no net._http_response).
--
-- ORDEM (3 fases — o custo de produção depende do cmc dos INSUMOS estar fresco):
--   omie-sync-estoque-diario (0 9)  →  compute-costs-daily (45 */2, ex. 10:45)  →  ESTE (30 11).
--   Recompor antes do cmc fresco = margem híbrida (achado do Codex). 1x/dia basta (estrutura muda pouco).
--
-- net.http_post SÓ ENFILEIRA: a edge responde 202 e roda em waitUntil (background, ~260 ConsultarEstrutura).
-- timeout_milliseconds EXPLÍCITO (default 5s mata silencioso — CLAUDE.md/sync.md); cobre só o 202.
-- Verdade HTTP vive em net._http_response, NÃO em cron.job_run_details (que só prova o ENQUEUE).

DO $do$
BEGIN
  PERFORM cron.unschedule('caca-custo-producao-colacor-daily');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'caca-custo-producao-colacor-daily',
  '30 11 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body := '{"action": "sync_custo_producao", "account": "colacor_vendas"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
