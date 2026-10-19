-- 3º disparo MANUAL do completo da omie-sync-pedidos-compra (v1.5) para a OBEN — DIAGNÓSTICO (2026-10-18 ~21:10 UTC).
-- Os dois anteriores (recibos #512 e #514) morreram logo após abrir a tentativa da passada de encerrados, mas os
-- logs da edge no Lovable Cloud retêm só ~10 min (docs/agent/sync.md) e já tinham expirado. Este disparo existe para
-- LER o log da edge dentro da janela (via agente do Lovable, sem editar nada). Mesmo modelo do redisparo: cliente
-- corta em 25s como o omie-cron-diario; fora do incremental (:15 das horas pares). `habilitado` segue false.
-- pg_net enfileira no COMMIT: no --ensaio o ROLLBACK desfaz o disparo. request_id sai por NOTICE.
DO $disparo$
DECLARE
  v_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-pedidos-compra',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('empresa', 'OBEN', 'modo', 'completo'),
    timeout_milliseconds := 25000)
  INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'disparo: net.http_post não devolveu request_id';
  END IF;
  RAISE NOTICE 'DISPARO_REQUEST_ID=%', v_id;
END
$disparo$;
