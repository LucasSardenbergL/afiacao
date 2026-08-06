-- ============================================================
-- cron `tactical-plans-batch-nightly` — pré-geração noturna dos planos táticos
--
-- Cria o agendamento que faltava para a edge `tactical-plans-batch`. A edge está deployada e
-- respondendo em produção desde #1422/#1498 (confirmado 2026-07-21: POST sem secret → 401, o
-- gate `authorizeCron` funcionando), mas nunca teve cron — rodava só sob invocação manual.
--
-- ⚠️ SCHEDULE É UTC, não BRT — `cron.timezone` está vazio no projeto (#1510). '0 8 * * *'
-- dispara às 05:00 BRT. É o primeiro slot DEPOIS de todas as dependências do batch:
--   06:00 UTC `daily-calculate-scores`           → grava os scores que o gate de R$/h consome
--   06:00 UTC `scoring-recalc-batch-nightly`     → recalcula priority_score
--   07:00 UTC `visit-score-recalc-batch-nightly` → recalcula o score de visita
--   07:30 UTC `carteira-rebuild-nightly`         → reconstrói carteira_assignments, a allowlist
--                                                  de elegíveis que o batch lê no passo 0
-- Antecipar o horário faz o batch ler a margem e a carteira do dia anterior.
--
-- Secret vem do VAULT. NUNCA `current_setting('app.cron_shared_key', true)`: essa GUC não existe
-- no projeto, o `true` (missing_ok) devolve NULL calado, o header sai nulo e a edge responde 401
-- — com `cron.job_run_details` marcando `succeeded`, porque só registra o ENQUEUE do
-- net.http_post (a verdade HTTP está em `net._http_response`). Ver #1513/#1516.
--
-- `timeout_milliseconds := 150000` (teto padrão da casa, docs/agent/sync.md): 3 vendedoras ×
-- top-25 = ≤75 chamadas LLM com CONCURRENCY 5 → ~15 chunks de ~5s. O default do pg_net é 5s e
-- mataria o batch em silêncio.
--
-- `cron.schedule` faz upsert por nome → idempotente, pode rerodar sem duplicar.
-- ============================================================

SELECT cron.schedule(
  'tactical-plans-batch-nightly',
  '0 8 * * *',
  $$SELECT net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tactical-plans-batch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
      ),
      body := '{"triggered_by":"cron"}'::jsonb,
      timeout_milliseconds := 150000
  );$$
);
