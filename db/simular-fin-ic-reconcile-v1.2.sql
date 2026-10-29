-- Conferência pós-deploy do fin-ic-reconcile v1.2 (#3294): `{"simular": true}` roda a conciliação
-- inteira (6 consultas ao Omie + leitura de CR/CP/matches) e NÃO escreve em fin_ic_matches.
-- Só dispara DEPOIS da sonda confirmar v1.2: o bundle pré-sensor ignoraria o corpo e escreveria.
-- (Sonda: db/sonda-disparo-fin-ic-reconcile-v1.2.sql → DEPLOY CONFIRMADO, request 125764.)
-- O request_id sai por NOTICE (o db:aplicar roda por EXECUTE e descarta o SELECT); a resposta se
-- lê depois, no read-only, em net._http_response WHERE id = <esse id>.
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
