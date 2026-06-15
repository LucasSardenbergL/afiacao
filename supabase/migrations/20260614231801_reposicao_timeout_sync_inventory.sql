-- ============================================================
-- reposicao_timeout_sync_inventory — sobe timeout_milliseconds 60000→150000
-- nos 2 crons sync-inventory pesados (omie-analytics-sync), alinhando com os outros
-- 23 crons que já usam 150000 (padrão da casa pós-incidente de 27/05).
--
-- Motivo: o omie-analytics-sync action sync_inventory das contas pesadas (vendas/oben,
-- colacor_vendas) estoura o timeout de 60s e deixa o inventory_position defasado (cmc
-- velho → NCG/otimizador/preço-de-pedido cmc-first). A conta leve (servicos, :25) completa.
-- Diagnóstico: docs/superpowers/specs/2026-06-14-incidente-sync-inventory-timeout.md
--
-- ⚠️ EXPERIMENTO MEDÍVEL, não correção confirmada: só resolve se a edge terminar entre
-- 60-150s. Se a edge tiver budget interno < 150s ou demorar mais, o fix real é paginar/
-- waitUntil a edge (deploy via Lovable). Revalidar via: select account, min(updated_at)
-- from inventory_position group by account; (vendas/colacor_vendas devem sair de 05-25/06-03).
--
-- cron.schedule faz upsert por nome → idempotente (re-rodar é seguro). Schedule e command
-- idênticos aos atuais; SÓ o timeout_milliseconds muda (60000 → 150000).
-- ============================================================

SELECT cron.schedule(
  'sync-inventory-vendas-30m',
  '*/30 * * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_inventory", "account": "vendas"}'::jsonb,
    timeout_milliseconds := 150000
  );$cron$
);

SELECT cron.schedule(
  'sync-inventory-colacor-vendas-1h',
  '15 * * * *',
  $cron$SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action":"sync_inventory","account":"colacor_vendas"}'::jsonb, timeout_milliseconds:=150000);$cron$
);
