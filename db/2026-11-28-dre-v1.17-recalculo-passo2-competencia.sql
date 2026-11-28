-- DRE v1.17 (#4302, item 2 das pendências de docs/historico/dre-mapa-proprio-nao-resultado.md):
-- recálculo DEPOIS do mapa 1.03.01 → cmv (db/2026-11-27-fin-dre-cmv-redutora.sql, aplicado em 2026-11-28).
-- Dispara `omie-financeiro` action `calcular_dre` (a mesma chamada do cron `fin-dre-recalculo-diario`)
-- EXATAMENTE sobre os snapshots de colacor e oben que existem hoje (inventário psql-ro 2026-11-28).
-- Nenhum mês novo. colacor_sc fica de fora: o mapa dela não mudou e o sinal por natureza não muda
-- nenhum número publicado (medido no #4302). Ordem: passo 1 → passo 2 → caixa colacor → caixa oben,
-- uma de cada vez (na v1.13, 13 requisições simultâneas falharam fechado por carga).
-- Depois de cada um: conferir net._http_response dos request_ids do NOTICE (status 200).
-- PASSO 2 (só DEPOIS do passo 1 concluir): competência de novo — o imposto teórico e o RBT12 leem
-- os meses/trimestres JÁ persistidos.
DO $recalculo$
DECLARE
  r bigint;
  ids jsonb := '{}'::jsonb;
  segredo text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1);
BEGIN
  IF segredo IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_CRON_SECRET'; END IF;
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor'),
                               'ano', 2023, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor 2023 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor|2023|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor'),
                               'ano', 2024, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor 2024 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor|2024|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor'),
                               'ano', 2025, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor 2025 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor|2025|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor'),
                               'ano', 2026, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor 2026 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor|2026|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben'),
                               'ano', 2024, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID oben 2024 competencia'; END IF;
  ids := ids || jsonb_build_object('oben|2024|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben'),
                               'ano', 2025, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID oben 2025 competencia'; END IF;
  ids := ids || jsonb_build_object('oben|2025|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben'),
                               'ano', 2026, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID oben 2026 competencia'; END IF;
  ids := ids || jsonb_build_object('oben|2026|competencia', r);
  RAISE NOTICE 'RECALCULO_REQUEST_IDS=%', ids;
END
$recalculo$;
