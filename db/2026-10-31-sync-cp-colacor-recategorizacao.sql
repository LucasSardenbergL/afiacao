-- Sincroniza agora as contas a pagar da colacor (`omie-financeiro`, action `sync_contas_pagar`) — a mesma
-- chamada do cron `fin-sync-cp-2x`, antecipada a pedido do founder em 2026-10-31. Motivo: ele recategorizou
-- no Omie os lançamentos 5156250202 (R$ 342,00) e 5171876028 (R$ 700,00) de 2.09.05 "Devolução de
-- Clientes" para 2.01.01 "Compras de Mercadorias para Revenda" (pares oben→colacor de 2026-03 e 2026-06,
-- ver docs/historico/fin-ic-reconcile-contraparte-por-codigo.md). Idempotente: é o mesmo upsert do cron.
-- O request_id sai por NOTICE; a resposta se lê no read-only, em net._http_response.
DO $sync$
DECLARE
  r bigint;
  segredo text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1);
BEGIN
  IF segredo IS NULL THEN
    RAISE EXCEPTION 'SYNC_SEM_CRON_SECRET';
  END IF;
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'sync_contas_pagar', 'company', 'colacor'),
    timeout_milliseconds := 150000) INTO r;
  IF r IS NULL THEN
    RAISE EXCEPTION 'SYNC_SEM_REQUEST_ID';
  END IF;
  RAISE NOTICE 'SYNC_REQUEST_ID=%', r;
END
$sync$;
