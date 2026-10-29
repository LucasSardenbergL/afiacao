-- Recalcula o DRE de competência de 2024-11, 2025-05 e 2025-06 (oben, colacor, colacor_sc) pelo motor
-- atual (`omie-financeiro`, action `calcular_dre`). Motivo: os snapshots são de 2026-03/05, anteriores a
-- `detalhamento.composicao_*`; sem composição a `fin_consolidado_intercompany` não prova os 11 pares IC
-- desses meses e sai NULL ("eliminação pendente"). Autorizado pelo founder em 2026-10-21. Os meses não
-- têm linha em fin_fechamentos. Foto do ANTES (9 linhas, com detalhamento):
-- db/dre-antes-recalculo-ic-2026-10-21.json. Os request_id saem por NOTICE; as respostas se leem no
-- read-only, em net._http_response.
DO $recalculo$
DECLARE
  r2024 bigint;
  r2025 bigint;
  segredo text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1);
BEGIN
  IF segredo IS NULL THEN
    RAISE EXCEPTION 'RECALCULO_SEM_CRON_SECRET';
  END IF;
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben', 'colacor', 'colacor_sc'),
                               'ano', 2024, 'meses', jsonb_build_array(11), 'regime', 'competencia'),
    timeout_milliseconds := 150000) INTO r2024;
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben', 'colacor', 'colacor_sc'),
                               'ano', 2025, 'meses', jsonb_build_array(5, 6), 'regime', 'competencia'),
    timeout_milliseconds := 150000) INTO r2025;
  IF r2024 IS NULL OR r2025 IS NULL THEN
    RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID';
  END IF;
  RAISE NOTICE 'RECALCULO_REQUEST_IDS=%,%', r2024, r2025;
END
$recalculo$;
