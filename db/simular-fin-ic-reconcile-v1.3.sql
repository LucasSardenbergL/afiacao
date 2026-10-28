-- Conferência pós-deploy do fin-ic-reconcile v1.3 (#3381): `{"simular": true}` roda a conciliação
-- inteira e NÃO escreve nada: nem fin_ic_matches, nem o mapa de contraparte, nem o marco
-- (o retorno do simular vem ANTES de gravarContrapartes/marcoDaRodada).
-- Só dispara DEPOIS da sonda (db/sonda-disparo-fin-ic-reconcile-v1.3.sql → DEPLOY CONFIRMADO, request 135067).
-- O request_id sai por NOTICE; a resposta se lê depois, no read-only, em net._http_response.
DO $simular$
DECLARE
  rid bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-ic-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object('simular', true),
    timeout_milliseconds := 150000) INTO rid;
  IF rid IS NULL THEN
    RAISE EXCEPTION 'SIMULAR_SEM_REQUEST_ID';
  END IF;
  RAISE NOTICE 'SIMULAR_REQUEST_ID=%', rid;
END
$simular$;
