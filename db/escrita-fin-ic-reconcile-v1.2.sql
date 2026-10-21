-- 1ª escrita pós-deploy do fin-ic-reconcile v1.2 (#3294): `{}` (= o disparo do cron) roda a conciliação
-- inteira (6 consultas ao Omie + leitura de CR/CP/matches) e ESCREVE em fin_ic_matches — a 1ª escrita, conferida antes pelo simular (request 125770: 11 auto_matched).
-- Só dispara DEPOIS da sonda (v1.2 confirmada) e do simular conferido.
-- (Sonda: db/sonda-disparo-fin-ic-reconcile-v1.2.sql → DEPLOY CONFIRMADO, request 125764.)
-- O request_id sai por NOTICE (o db:aplicar roda por EXECUTE e descarta o SELECT); a resposta se
-- lê depois, no read-only, em net._http_response WHERE id = <esse id>.
DO $escrita$
DECLARE
  rid bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-ic-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000) INTO rid;
  IF rid IS NULL THEN
    RAISE EXCEPTION 'ESCRITA_SEM_REQUEST_ID';
  END IF;
  RAISE NOTICE 'ESCRITA_REQUEST_ID=%', rid;
END
$escrita$;
