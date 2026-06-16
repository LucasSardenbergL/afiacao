-- ============================================================
-- Financeiro: crons por-entidade com budget dedicado (fix #1, 2026-05-24/25).
--
-- Problema: o fin-omie-sync-2x-diario fazia 'sync_all' (1 invocação/empresa),
-- e o time-budget de 130s era COMPARTILHADO entre cats/CC/CP/CR/mov. O CP da
-- colacor (116 págs a 100/pág — o Omie capa em 100, ignora 500) consumia o
-- budget antes de CR/mov rodarem → CR colacor parava em ~6 págs, mov em 0.
--
-- Fix: separar por entidade. Cada action (sync_contas_pagar/receber/
-- movimentacoes) numa invocação própria reseta o budget → ganha os 130s
-- inteiros. colacor CR (292 págs × ~0,4s ≈ 117s) cabe sozinho.
--
-- Concorrência: as 3 empresas são CONTAS Omie distintas (rate-limit por conta),
-- então disparar as 3 juntas (mesmo cron) é seguro. Escalono ENTRE entidades
-- (CP 08h / CR 08h20 / mov 08h40) pra uma mesma conta não fazer CP+CR+mov
-- simultâneo. cats/CC (minúsculos) ficam num cron diário separado às 06h.
--
-- cron.schedule = upsert por nome (idempotente).
-- ============================================================

-- Remove o cron antigo de sync_all (substituído pelos por-entidade). Idempotente.
DO $unsched$
BEGIN
  PERFORM cron.unschedule('fin-omie-sync-2x-diario');
EXCEPTION WHEN OTHERS THEN
  NULL; -- já não existe
END $unsched$;

-- Base (categorias + contas correntes): pequenos, 1x/dia às 06h UTC.
SELECT cron.schedule(
  'fin-sync-base-diario',
  '0 6 * * *',
  $cron$
  DO $inner$ DECLARE c text; BEGIN
    FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
        body := jsonb_build_object('action','sync_categorias','company',c),
        timeout_milliseconds := 60000
      );
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
        body := jsonb_build_object('action','sync_contas_correntes','company',c),
        timeout_milliseconds := 60000
      );
    END LOOP;
  END $inner$;
  $cron$
);

-- Contas a pagar: 2x/dia (08h/14h UTC), 1 invocação por empresa.
SELECT cron.schedule(
  'fin-sync-cp-2x',
  '0 8,14 * * *',
  $cron$
  DO $inner$ DECLARE c text; BEGIN
    FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
        body := jsonb_build_object('action','sync_contas_pagar','company',c),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cron$
);

-- Contas a receber: 2x/dia às 08h20/14h20 (escalonado vs CP — budget dedicado).
SELECT cron.schedule(
  'fin-sync-cr-2x',
  '20 8,14 * * *',
  $cron$
  DO $inner$ DECLARE c text; BEGIN
    FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
        body := jsonb_build_object('action','sync_contas_receber','company',c),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cron$
);

-- Movimentações: 2x/dia às 08h40/14h40 (escalonado — early-exit na janela de 3 meses).
SELECT cron.schedule(
  'fin-sync-mov-2x',
  '40 8,14 * * *',
  $cron$
  DO $inner$ DECLARE c text; BEGIN
    FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
        body := jsonb_build_object('action','sync_movimentacoes','company',c),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cron$
);
