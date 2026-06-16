-- Restaura o cron do sync INBOUND de pedidos de venda (omie-vendas-sync / sync_pedidos),
-- que cria linha nova em sales_orders a partir do Omie.
--
-- CONTEXTO (incidente 2026-05-27): sales_orders ficou congelada por 8 dias (oben parou em
-- 19/05; colacor em 17/04). Causa-raiz: NENHUM cron chamava omie-vendas-sync sync_pedidos.
-- Os crons de vendas ativos chamam omie-analytics-sync (que SÓ enriquece pedido existente,
-- gate `if (existingOrder)`, e ainda morre 546 WORKER_RESOURCE_LIMIT). O cron de sync_pedidos
-- existia no banco mas nunca foi versionado em migration → foi perdido sem rastro.
-- ESTA migration versiona o cron pra que isso não se repita (a lição do incidente).
--
-- Desenho (revisado com codex): contas separadas e escalonadas; janela ROLANTE (data de/até
-- computadas em runtime, fuso America/Sao_Paulo, 5 dias de margem — a função é idempotente por
-- hash_payload, então overlap é barato e não duplica); max_pages 10 (bounded p/ caber no
-- wall-clock ~150s da edge). sync_pedidos (insert) roda ANTES do enrich do analytics-sync.
-- Monitoramento: omie-vendas-sync loga em fin_sync_log (action='sync_pedidos') → o watchdog
-- fin_sync_watchdog (#321/#330) passa a cobrir vendas. cron.schedule faz upsert por nome
-- (idempotente — pode rerodar).

-- OBEN (carteira principal) — a cada 2h, :05
SELECT cron.schedule(
  'vendas-sync-pedidos-oben-2h',
  '5 */2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object(
      'action','sync_pedidos',
      'account','oben',
      'date_from', to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5, 'DD/MM/YYYY'),
      'date_to',   to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date,     'DD/MM/YYYY'),
      'start_page', 1,
      'max_pages', 10
    ),
    timeout_milliseconds := 150000
  );
  $cron$
);

-- COLACOR — a cada 2h, :20 (escalonado 15min depois do oben)
SELECT cron.schedule(
  'vendas-sync-pedidos-colacor-2h',
  '20 */2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
    ),
    body := jsonb_build_object(
      'action','sync_pedidos',
      'account','colacor',
      'date_from', to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5, 'DD/MM/YYYY'),
      'date_to',   to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date,     'DD/MM/YYYY'),
      'start_page', 1,
      'max_pages', 10
    ),
    timeout_milliseconds := 150000
  );
  $cron$
);
