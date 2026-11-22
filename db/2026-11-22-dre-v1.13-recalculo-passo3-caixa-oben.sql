-- DRE v1.13 (#4129) — recálculo PASSO 3: caixa 2026 da oben SOZINHO. No passo 2 ele falhou fechado
-- por carga (13 requisições simultâneas: colacor 57014 em fin_titulo_baixas_cr_mapa; oben
-- WORKER_RESOURCE_LIMIT). Uma requisição por arquivo, aplicados em sequência.
DO $recalculo$
DECLARE
  r bigint;
  segredo text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1);
BEGIN
  IF segredo IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_CRON_SECRET'; END IF;
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben'),
                               'ano', 2026, 'meses', jsonb_build_array(4, 5, 6, 7, 8, 9, 10, 11), 'regime', 'caixa'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID'; END IF;
  RAISE NOTICE 'RECALCULO_REQUEST_ID=%', r;
END
$recalculo$;
