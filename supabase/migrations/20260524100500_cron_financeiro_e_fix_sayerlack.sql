-- ============================================================
-- (1) Cria o cron que faltava do FINANCEIRO + (2) conserta o sayerlack
--
-- Contexto: diagnóstico de 2026-05-24 achou que NÃO existia cron puxando
-- contas a pagar/receber/movimentações do Omie (fin_* parado há ~56 dias),
-- e que o sayerlack-portal-watchdog mandava x-cron-secret de um GUC nunca
-- setado (app.settings.cron_secret) → NULL → 401.
--
-- cron.schedule faz upsert por nome → idempotente, pode rerodar.
--
-- ⚠️ PRÉ-REQUISITO pro cron de financeiro: a edge function omie-financeiro
-- precisa estar redeployada com suporte a x-cron-secret (edição em
-- validateCaller). Sem isso, o cron dispara mas a função responde 403.
-- ============================================================

-- (1) FINANCEIRO — sync_all por empresa, 2x/dia (08h e 14h UTC = 05h e 11h BRT).
--     08h roda antes do snapshot da projeção (fin-cashflow-snapshot-diario, 10h UTC),
--     garantindo que o snapshot leia dados frescos. Uma chamada por empresa
--     (isola falha e mantém cada invocação dentro do wall-clock da function).
SELECT cron.schedule(
  'fin-omie-sync-2x-diario',
  '0 8,14 * * *',
  $cron$
  DO $inner$
  DECLARE c text;
  BEGIN
    FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('action', 'sync_all', 'company', c),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cron$
);

-- (2) SAYERLACK — lê x-cron-secret do Vault (antes vinha de um GUC nunca setado).
--     Mantém schedule */5, modo watchdog e janela de 5 min.
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
