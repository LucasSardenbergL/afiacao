-- DRE v1.13 (#4129) — recálculo PASSO 2 (só DEPOIS do passo 1 concluir): competência de novo — o imposto teórico e o RBT12 leem os meses/trimestres JÁ persistidos (Codex) — e o caixa de 2026.
-- Dispara `omie-financeiro` action `calcular_dre` (mesma chamada do cron `fin-dre-recalculo-diario`)
-- EXATAMENTE sobre os snapshots que existem hoje (inventário psql-ro 2026-11-22). Nenhum mês novo.
-- Depois: conferir net._http_response dos request_ids do NOTICE (status 200) e o antes/depois.
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
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor_sc'),
                               'ano', 2024, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor_sc 2024 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor_sc|2024|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor_sc'),
                               'ano', 2025, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor_sc 2025 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor_sc|2025|competencia', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor_sc'),
                               'ano', 2026, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), 'regime', 'competencia'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor_sc 2026 competencia'; END IF;
  ids := ids || jsonb_build_object('colacor_sc|2026|competencia', r);
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
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor'),
                               'ano', 2026, 'meses', jsonb_build_array(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11), 'regime', 'caixa'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor 2026 caixa'; END IF;
  ids := ids || jsonb_build_object('colacor|2026|caixa', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('colacor_sc'),
                               'ano', 2026, 'meses', jsonb_build_array(9, 10, 11), 'regime', 'caixa'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID colacor_sc 2026 caixa'; END IF;
  ids := ids || jsonb_build_object('colacor_sc|2026|caixa', r);
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := jsonb_build_object('action', 'calcular_dre', 'companies', jsonb_build_array('oben'),
                               'ano', 2026, 'meses', jsonb_build_array(4, 5, 6, 7, 8, 9, 10, 11), 'regime', 'caixa'),
    timeout_milliseconds := 300000) INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'RECALCULO_SEM_REQUEST_ID oben 2026 caixa'; END IF;
  ids := ids || jsonb_build_object('oben|2026|caixa', r);
  RAISE NOTICE 'RECALCULO_REQUEST_IDS=%', ids;
END
$recalculo$;
