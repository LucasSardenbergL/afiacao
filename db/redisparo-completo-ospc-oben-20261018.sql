-- REdisparo MANUAL do completo da omie-sync-pedidos-compra (v1.5) para a OBEN (pedido do founder,
-- 2026-10-18 20:20 UTC). O 1º disparo (disparo-completo-ospc-oben-20261018.sql, recibo #512) segurou a
-- conexão por até 300s e o gateway cortou em 150s (504 IDLE_TIMEOUT) no meio da passada de encerrados:
-- registro preso em `coletando` (seq 143). Aqui o cliente corta em 25s, como o omie-cron-diario faz — a
-- edge segue server-side até o fim (caminho provado em prod 2026-06-26). A nova tentativa tem seq maior e
-- substitui o registro preso. `habilitado` segue false: a passada só OBSERVA.
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
