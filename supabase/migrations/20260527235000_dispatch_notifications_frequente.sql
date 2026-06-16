-- Hardening do canal de alerta (1/2): a cadência do dispatch-notifications era DIÁRIA (10 11 * * *),
-- então os alertas da Sentinela (watchdog */30 → enfileira em fornecedor_alerta) só saíam por email
-- no batch das 11:10 → latência de alerta de até ~24h, o que contradiz o "ativo" (o incidente que
-- originou tudo era sobre VELOCIDADE: 8 dias mudo). Bump pra */30 (alinha com o watchdog; latência
-- worst-case ~60min). Idle é barato: o dispatch faz early-return em 0 pendentes ANTES de pegar token
-- OAuth/chamar Gmail. Volume bounded: o anti-spam (UNIQUE parcial em fin_alertas (company,tipo)
-- WHERE dismissed_at IS NULL) já garante 1 email por transição — */30 só envia MAIS CEDO, não mais.
-- Renomeio o job (o nome "diario" viraria mentira). unschedule guardado por jobid = idempotente
-- (no-op se ausente; nunca deixa 2 crons ativos). Comando idêntico ao atual (mesma URL/headers/body/
-- timeout) — só schedule + nome mudam.

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'afiacao_dispatch_notificacoes_diario';

SELECT cron.schedule('afiacao_dispatch_notificacoes_30min', '*/30 * * * *',
  ' select net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/dispatch-notifications'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'') ), body := ''{}''::jsonb, timeout_milliseconds := 60000 ); ');
