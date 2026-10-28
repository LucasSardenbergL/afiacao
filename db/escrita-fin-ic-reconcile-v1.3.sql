-- 1ª escrita pós-deploy do fin-ic-reconcile v1.3 (#3381): `{}` (= o disparo do cron) roda a conciliação,
-- grava o mapa de contraparte (fin_ic_contrapartes, só acrescenta), o marco da rodada
-- (fin_ic_reconcile_rodadas — abre a trava de bootstrap da venda sem cobrança) e só então publica a fila.
-- Só dispara DEPOIS da sonda (request 135067) e do simular conferido.
-- O request_id sai por NOTICE; a resposta se lê depois, no read-only, em net._http_response.
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
