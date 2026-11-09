-- Recalcula o DRE de competência da colacor em 2026-03 e 2026-06 (`omie-financeiro`, action `calcular_dre`) —
-- a mesma chamada do cron `fin-dre-recalculo-diario`, antecipada a pedido do founder em 2026-10-31, logo
-- depois de db/2026-10-31-sync-cp-colacor-recategorizacao.sql trazer os lançamentos 5156250202 (R$ 342,00) e
-- 5171876028 (R$ 700,00) em 2.01.01. Esperado: deduções −342/−700 e CMV +342/+700; resultado intacto.
-- Antes (psql-ro, snapshot de 2026-10-31 15:30Z): mar deduções 23133.72 · cmv 47215.98 · resultado
-- −57183.93; jun deduções 24198.33 · cmv 25915.43 · resultado −25653.18.
DO $recalculo$
DECLARE
  r bigint;
  segredo text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1);
BEGIN
  IF segredo IS NULL THEN
    RAISE EXCEPTION 'RECALCULO_SEM_CRON_SECRET';
  END IF;
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor'),
                               'ano', 2026, 'meses', jsonb_build_array(3, 6), 'regime', 'competencia'),
    timeout_milliseconds := 150000) INTO r;
  IF r IS NULL THEN
    RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID';
  END IF;
  RAISE NOTICE 'RECALCULO_REQUEST_ID=%', r;
END
$recalculo$;
