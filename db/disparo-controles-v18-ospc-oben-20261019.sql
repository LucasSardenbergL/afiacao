-- Disparo MANUAL do completo da omie-sync-pedidos-compra para a OBEN — CONTROLES do R59 na v1.8 (2026-10-19 ~02:42 UTC).
-- A v1.8 (#3167) grava, na abstenção da passada de encerrados, o conjunto observado em
-- sync_state.metadata.diagnostico (só diagnóstico; o registro protegido segue 'invalidado' sem ids e o backtest
-- intacto). Ler o diagnóstico LOGO após o fim: o 'running' da próxima passada o sobrescreve. Cliente corta em
-- 25s, como o omie-cron-diario; fora do incremental (:15 das horas pares). `habilitado` segue false.
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
