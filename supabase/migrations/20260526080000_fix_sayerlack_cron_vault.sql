-- 20260526080000_fix_sayerlack_cron_vault.sql
-- ============================================================
-- Remove o JWT anon hardcoded do cron sayerlack-portal-watchdog.
-- Follow-up do item 2 do supabase/schema-security-report.md (P2 codex #246).
-- ============================================================
-- Estado atual em prod (confirmado por dump de cron.job 2026-05-26):
--   O cron embute um JWT anon LITERAL nos headers Authorization + apikey
--   (os outros ~32 crons não fazem isso). O `x-cron-secret` JÁ vem do Vault
--   (decrypted_secrets/CRON_SECRET) — ou seja, o watchdog autoriza certo pela
--   1ª checagem do authorizeCronOrStaff (x-cron-secret == CRON_SECRET → true);
--   o JWT anon só existia pra passar o verify_jwt do GATEWAY do Supabase.
--   Severidade: BAIXA (a anon key é pública — vai no bundle do front), mas
--   higiene ruim ter o literal baked no cron + no dump.
--
-- ⚠️ PRÉ-REQUISITO (ordem importa): a edge function `enviar-pedido-portal-sayerlack`
--   precisa estar com `verify_jwt = false` (ajuste no chat do Lovable) ANTES
--   de aplicar esta migration. Com verify_jwt=false o gateway deixa a request
--   passar sem JWT e a própria função gateia via x-cron-secret (igual aos
--   ~32 crons que já rodam assim). Se aplicar com verify_jwt ainda = true, o
--   gateway dá 401 e o watchdog (que concilia pedidos Sayerlack travados em
--   `enviando_portal`) PARA. Conferir o resultado em `net._http_response`
--   (status_code 200) depois de aplicar.
--
-- cron.schedule faz upsert por nome → idempotente, sobrescreve a versão com JWT.
-- Preserva URL, schedule (*/5) e body ({watchdog:true, minutos:5}) atuais;
-- só troca os headers (remove Authorization + apikey; mantém x-cron-secret Vault).

SELECT cron.schedule(
  'sayerlack-portal-watchdog',
  '*/5 * * * *',
  $cron$SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/enviar-pedido-portal-sayerlack',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object('watchdog', true, 'minutos', 5)
  );$cron$
);

-- ============================================================
-- Validação
-- ============================================================
SELECT
  CASE
    WHEN command ILIKE '%eyJ%'                          THEN '❌ ainda tem JWT hardcoded (eyJ...)'
    WHEN command NOT ILIKE '%decrypted_secret%CRON_SECRET%' THEN '❌ x-cron-secret não vem do Vault'
    WHEN command ILIKE '%app.settings.cron_secret%'     THEN '⚠️ ainda usa GUC app.settings.cron_secret'
    ELSE '✅ cron limpo: x-cron-secret do Vault, sem JWT anon hardcoded'
  END AS status
FROM cron.job
WHERE jobname = 'sayerlack-portal-watchdog';
