-- Disparo MANUAL de uma passada COMPLETA da omie-sync-pedidos-compra (v1.5) para a OBEN, pedido do
-- founder em 2026-10-18: antecipa o 1º conjunto `observado` da passada de encerrados (R59, #3132), que
-- só roda depois de um completo LIMPO. Sem `trigger: "cron"` → caminho manual; `modo` explícito =
-- completo. Mesma auth do cron (x-cron-secret do vault). `habilitado` segue false: a passada só
-- OBSERVA — nada sai do caixa por este disparo.
-- pg_net enfileira no COMMIT: no --ensaio o ROLLBACK desfaz o disparo (nada é chamado).
-- O request_id sai por NOTICE (o EXECUTE do aplicar_sql descarta o SELECT); a resposta HTTP fica em
-- net._http_response (leitura no psql-ro).
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
    timeout_milliseconds := 300000)
  INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'disparo: net.http_post não devolveu request_id';
  END IF;
  RAISE NOTICE 'DISPARO_REQUEST_ID=%', v_id;
END
$disparo$;
