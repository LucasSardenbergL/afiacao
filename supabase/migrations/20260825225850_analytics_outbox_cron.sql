-- ============================================================
-- Cron do worker da `analytics_outbox`
--
-- ⚠️ ORDEM DE APPLY — esta migration é a SEGUNDA, e a ordem não é preferência:
--   1. `20260825214545_analytics_outbox.sql` (tabela, trigger, RPCs)
--   2. deploy da edge `analytics-outbox-drain` (Lovable: publicação MANUAL)
--   3. ESTA
-- Aplicá-la antes do passo 2 aponta o cron para uma função que não existe: ele
-- bate 404 a cada 5 minutos e `cron.job_run_details = succeeded` — que só prova
-- o ENQUEUE — mostra tudo verde. A verdade HTTP está em `net._http_response`.
--
-- Separada do arquivo irmão exatamente por isso: no Lovable, migration e edge
-- são publicações MANUAIS e INDEPENDENTES, e um arquivo só forçaria o cron a
-- nascer junto com a tabela, antes de haver o que chamar.
-- ============================================================

-- Idempotente: remove antes de recriar (house style do repo).
SELECT cron.unschedule('analytics-outbox-drain')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'analytics-outbox-drain');

SELECT cron.schedule(
  'analytics-outbox-drain',
  '*/5 * * * *',
  $$SELECT net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/analytics-outbox-drain',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        -- do Vault, nunca literal: o secret rotaciona e o valor na unha vira 401 mudo.
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
      ),
      -- ⚠️ EXPLÍCITO. O default do pg_net é 5s e mata a chamada em silêncio;
      -- o lote é de 200 eventos, e uma janela curta produziria fila crescendo
      -- com o cron reportando sucesso.
      timeout_milliseconds := 55000
  );$$
);

-- ------------------------------------------------------------
-- Como CONFERIR que isto está mesmo funcionando (não basta o cron verde)
-- ------------------------------------------------------------
-- 1. O cron rodou (só prova o ENQUEUE):
--      SELECT jobname, status, start_time FROM cron.job_run_details
--       WHERE jobname = 'analytics-outbox-drain' ORDER BY start_time DESC LIMIT 5;
-- 2. O HTTP respondeu (a verdade):
--      SELECT status_code, created FROM net._http_response ORDER BY created DESC LIMIT 5;
-- 3. A fila está drenando (o efeito):
--      SELECT count(*) FILTER (WHERE aceito_em IS NULL AND quarentena_em IS NULL) AS na_fila,
--             count(*) FILTER (WHERE aceito_em IS NOT NULL) AS aceitos,
--             count(*) FILTER (WHERE quarentena_em IS NOT NULL) AS quarentena,
--             min(ocorrido_em) FILTER (WHERE aceito_em IS NULL AND quarentena_em IS NULL) AS mais_antigo_na_fila
--        FROM public.analytics_outbox;
-- 4. O trigger não está perdendo evento (fail-open é auditável):
--      SELECT * FROM public.analytics_outbox_reconciliacao;
--    `na_fonte` > `na_outbox` na linha de confiança 'prova' = trigger falhando.
