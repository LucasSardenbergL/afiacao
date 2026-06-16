-- Conserta o BUG SISTÊMICO do portal Sayerlack (descoberto pela investigação do Track A): o loop de
-- retry de envio ao portal NÃO TINHA motor agendado. O único cron (sayerlack-portal-watchdog */5) chama
-- a edge com {watchdog:true} → roda APENAS runWatchdog (des-trava itens presos em 'enviando_portal') e
-- RETORNA — nunca alcança o modo LOTE (que re-envia pendente_envio_portal/erro_retentavel com
-- portal_proximo_retry_em vencido). Resultado: todo envio que falha transitório (timeout do Browserless)
-- agenda um retry (+15min) que NUNCA é disparado → pedido órfão pra sempre. Era a causa do backlog de
-- ~R$21k de pedidos Sayerlack retentáveis parados desde 14-15/05.
--
-- FIX: cron dedicado que chama a edge em MODO LOTE (body {} = sem watchdog, sem pedido_id). O lote já é
-- bounded (MAX_PEDIDOS_POR_EXECUCAO=5/run) + async (202 + EdgeRuntime.waitUntil em background) + tem lock
-- anti-overlap, então é seguro agendar. */15 alinha com o backoff de retry de 15min. Idle é barato
-- (candidatos=0 → retorna rápido). Coexiste com o watchdog */5 (concerns distintos: enviando_portal preso
-- × re-envio de retentável). ⚠️ NÃO cobre: erro_nao_retentavel (SKU sem mapeamento — precisa mapear/cancelar),
-- falha_envio_portal com tentativas>=3 (precisa "Forçar reenvio ao portal" na UI), nem aprovado_aguardando_disparo
-- órfão (precisa re-disparo via disparar-pedidos-aprovados com pedido_id). Esses são triagem operacional.
-- ⚠️ Ao aplicar, o cron passa a re-enviar o backlog retentável atual (~R$21k, aprovado 14-15/05) — revise/
-- cancele os que estiverem obsoletos ANTES, se houver.

SELECT cron.schedule('sayerlack-portal-lote-retry', '*/15 * * * *',
  $$ SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/enviar-pedido-portal-sayerlack',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ); $$);
