-- Disparo MANUAL do completo da omie-sync-pedidos-compra para a OBEN — PROVA da v1.7 (2026-10-19 ~01:36 UTC).
-- A v1.7 (#3152) segura o worker no EdgeRuntime.waitUntil: o gateway segue derrubando a request aos 150s
-- (504 IDLE_TIMEOUT), mas o worker não pode mais sofrer EarlyDrop (~200s do boot) no meio da passada de
-- encerrados. Critério de aceite (Codex): a tentativa chegar a estado TERMINAL depois dos ~200s — registro
-- `observado` e heartbeat `pedidos_compra_encerrados` = complete. Cliente corta em 25s, como o
-- omie-cron-diario; fora do incremental (:15 das horas pares). `habilitado` segue false: a passada só OBSERVA.
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
