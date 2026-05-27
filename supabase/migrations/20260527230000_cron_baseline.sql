-- ============================================================
-- BASELINE DE CRONS — snapshot da topologia de pg_cron (2026-05-27)
-- ============================================================
-- LIÇÃO DO INCIDENTE 2026-05-27: o cron de vendas (omie-vendas-sync sync_pedidos) se perdeu
-- porque vivia SÓ no banco, nunca versionado → sumiu sem rastro e vendas ficou morto 8 dias.
-- Esta migration versiona TODOS os 45 crons ativos como safety net: se um sumir, re-rodar o
-- statement correspondente restaura. cron.schedule faz upsert por nome (idempotente).
--
-- GERADO automaticamente a partir de cron.job (active=true) via:
--   SELECT string_agg(format('SELECT cron.schedule(%L,%L,%L);', jobname, schedule, command), ...)
-- NÃO editar à mão. REGENERAR quando a topologia mudar (rodar o generator de novo e substituir).
-- NÃO precisa ser aplicada agora (os crons já existem em prod) — é artefato de recuperação.
-- Aplicar (todo ou em parte) só pra RESTAURAR um cron perdido. ⚠️ Re-aplicar troca o jobid
-- (reseta o histórico em job_run_details) — por isso só aplicar sob demanda, não de rotina.
-- ============================================================

SELECT cron.schedule('afiacao_ciclo_oportunidade_diario', '5 11 * * *', 'SELECT public.ciclo_oportunidade_do_dia(''OBEN'');');

SELECT cron.schedule('afiacao_dispatch_notificacoes_diario', '10 11 * * *', ' select net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/dispatch-notifications'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'') ), body := ''{}''::jsonb, timeout_milliseconds := 60000 ); ');

SELECT cron.schedule('afiacao_estados_eventos_diarios', '0 11 * * *', 'SELECT public.atualizar_estados_eventos_comerciais();');

SELECT cron.schedule('afiacao_limpeza_sugestoes_mensal', '0 6 1 * *', 'SELECT public.limpar_sugestoes_antigas();');

SELECT cron.schedule('afiacao_omie_oben_sku_items_history_daily', '0 7 * * *', ' select net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-sku-items'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''CRON_SECRET'') ), body := jsonb_build_object(''empresa'', ''OBEN'', ''dias'', 30), timeout_milliseconds := 120000 ); ');

SELECT cron.schedule('afiacao_omie_oben_sync_incremental_2h', '15 */2 * * *', ' select net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-cron-diario'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''CRON_SECRET'') ), body := jsonb_build_object(''empresa'', ''OBEN''), timeout_milliseconds := 120000 ); ');

SELECT cron.schedule('afiacao_ranking_refresh_semanal', '0 10 * * 1', 'SELECT public.refresh_sku_ranking_negociacao();');

SELECT cron.schedule('afiacao_sugestoes_diarias', '0 10 * * *', 'SELECT public.sugerir_negociacao_paralela_hoje(''OBEN'', 10);');

SELECT cron.schedule('call-log-missed-backstop', '* * * * *', 'UPDATE public.call_log SET status = CASE WHEN direction = ''inbound'' THEN ''missed''::public.call_status ELSE ''failed''::public.call_status END, ended_at = COALESCE(ended_at, now()) WHERE status = ''ringing'' AND started_at < now() - interval ''90 seconds''');

SELECT cron.schedule('carteira-positivacao-snapshot-mensal', '0 8 1 * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-positivacao-snapshot'', headers:=jsonb_build_object(''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), timeout_milliseconds:=150000);');

SELECT cron.schedule('carteira-rebuild-nightly', '30 7 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-rebuild'', headers:=jsonb_build_object(''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), timeout_milliseconds:=150000);');

SELECT cron.schedule('compute-association-rules-daily', '30 7 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"action": "compute_association_rules"}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('compute-costs-daily', '0 7 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"action": "compute_costs"}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('daily-calculate-scores', '0 6 * * *', ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/calculate-scores'', headers := jsonb_build_object(''Content-Type'',''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body := ''{"triggered_by":"cron"}''::jsonb, timeout_milliseconds := 150000 ); ');

SELECT cron.schedule('data-health-watchdog', '*/30 * * * *', 'SELECT public.data_health_watchdog()');

SELECT cron.schedule('detectar-outliers-diario', '30 7 * * *', ' SELECT detectar_outliers_empresa(''OBEN''); SELECT detectar_skus_sem_grupo(''OBEN''); ');

SELECT cron.schedule('disparar-pedidos-aprovados-oben', '0 13 * * *', ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/disparar-pedidos-aprovados'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := ''{"empresa":"OBEN"}''::jsonb, timeout_milliseconds := 150000 ) AS request_id; ');

SELECT cron.schedule('fin-cashflow-snapshot-diario', '0 10 * * *', ' DO $inner$ DECLARE c text; cen text; BEGIN FOREACH c IN ARRAY ARRAY[''oben'',''colacor'',''colacor_sc''] LOOP FOREACH cen IN ARRAY ARRAY[''realista'',''otimista'',''pessimista''] LOOP PERFORM net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := jsonb_build_object(''company'', c, ''cenario'', cen, ''save_snapshot'', true), timeout_milliseconds := 120000 ); END LOOP; END LOOP; END $inner$; ');

SELECT cron.schedule('fin-ic-reconcile-daily', '0 9 * * *', ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-ic-reconcile'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := ''{}''::jsonb, timeout_milliseconds := 120000 ); ');

SELECT cron.schedule('fin-refresh-analise-dimensoes', '0 10,16 * * *', 'SELECT public.fin_refresh_analise_dimensoes()');

SELECT cron.schedule('fin-sync-base-diario', '0 6 * * *', ' DO $inner$ DECLARE c text; BEGIN FOREACH c IN ARRAY ARRAY[''oben'',''colacor'',''colacor_sc''] LOOP PERFORM net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''action'',''sync_categorias'',''company'',c), timeout_milliseconds:=60000); PERFORM net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''action'',''sync_contas_correntes'',''company'',c), timeout_milliseconds:=60000); END LOOP; END $inner$; ');

SELECT cron.schedule('fin-sync-continuacao-10min', '*/10 * * * *', ' DO $inner$ DECLARE r record; BEGIN FOR r IN SELECT company, resource FROM public.fin_sync_cursor WHERE next_page IS NOT NULL LOOP PERFORM net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro'', headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body := jsonb_build_object(''action'',''sync_''||r.resource,''company'',r.company), timeout_milliseconds := 150000); END LOOP; END $inner$; ');

SELECT cron.schedule('fin-sync-cp-2x', '0 8,14 * * *', ' DO $inner$ DECLARE c text; BEGIN FOREACH c IN ARRAY ARRAY[''oben'',''colacor'',''colacor_sc''] LOOP PERFORM net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''action'',''sync_contas_pagar'',''company'',c), timeout_milliseconds:=150000); END LOOP; END $inner$; ');

SELECT cron.schedule('fin-sync-cr-2x', '20 8,14 * * *', ' DO $inner$ DECLARE c text; BEGIN FOREACH c IN ARRAY ARRAY[''oben'',''colacor'',''colacor_sc''] LOOP PERFORM net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''action'',''sync_contas_receber'',''company'',c), timeout_milliseconds:=150000); END LOOP; END $inner$; ');

SELECT cron.schedule('fin-sync-heartbeat', '0 11 * * 1-5', 'SELECT public.fin_sync_heartbeat()');

SELECT cron.schedule('fin-sync-mov-2x', '40 8,14 * * *', ' DO $inner$ DECLARE c text; BEGIN FOREACH c IN ARRAY ARRAY[''oben'',''colacor'',''colacor_sc''] LOOP PERFORM net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''action'',''sync_movimentacoes'',''company'',c), timeout_milliseconds:=150000); END LOOP; END $inner$; ');

SELECT cron.schedule('fin-sync-watchdog', '*/30 * * * *', 'SELECT public.fin_sync_watchdog_check()');

SELECT cron.schedule('gerar-pedidos-diario-oben', '15 9 * * *', ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/gerar-pedidos-diario'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1) ), body := ''{"empresa":"OBEN"}''::jsonb, timeout_milliseconds := 150000 ) AS request_id; ');

SELECT cron.schedule('monthly-tool-report', '0 9 1 * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/monthly-report'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"send_email": true}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('omie-sync-estoque-diario', '0 9,14,19 * * *', 'SELECT net.http_post( url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-estoque'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=''{"empresa": "OBEN"}''::jsonb, timeout_milliseconds := 90000 );');

SELECT cron.schedule('omie-sync-metadados-daily', '30 8 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-metadados'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"accounts":["vendas","colacor_vendas"]}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('omie-sync-status-produtos-diario', '30 6 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-status-produtos'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''empresa'',''ALL''),timeout_milliseconds:=150000);');

SELECT cron.schedule('process-recurring-orders-daily', '0 7 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/process-recurring-orders'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('sayerlack-portal-watchdog', '*/5 * * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/enviar-pedido-portal-sayerlack'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=jsonb_build_object(''watchdog'',true,''minutos'',5),timeout_milliseconds:=150000);');

SELECT cron.schedule('scoring-recalc-batch-nightly', '0 6 * * *', 'SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/scoring-recalc-batch'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''CRON_SECRET'' LIMIT 1) ), timeout_milliseconds := 55000 );');

SELECT cron.schedule('sync-colacor-vendas-products', '15 6 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"action": "sync_products", "account": "colacor_vendas", "max_pages": 50}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('sync-inventory-vendas-30m', '*/30 * * * *', 'SELECT net.http_post( url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=''{"action": "sync_inventory", "account": "vendas"}''::jsonb, timeout_milliseconds := 60000 );');

SELECT cron.schedule('sync-omie-services-hourly', '0 * * * *', 'SELECT net.http_post( url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=''{"action": "sync_services"}''::jsonb, timeout_milliseconds := 60000 );');

SELECT cron.schedule('sync-products-customers-daily', '0 6 * * *', 'SELECT net.http_post( url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body:=''{"action": "sync_all", "account": "vendas"}''::jsonb, timeout_milliseconds := 120000 );');

SELECT cron.schedule('sync-reprocess-operational', '15 */2 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sync-reprocess'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"action": "reprocess_operational", "account": "oben"}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('sync-reprocess-strategic', '30 2 * * *', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sync-reprocess'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"action": "reprocess_strategic", "account": "oben"}''::jsonb,timeout_milliseconds:=150000);');

SELECT cron.schedule('vendas-sync-pedidos-colacor-2h', '20 */2 * * *', ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync'', headers := jsonb_build_object(''Content-Type'',''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body := jsonb_build_object(''action'',''sync_pedidos'',''account'',''colacor'', ''date_from'', to_char((now() AT TIME ZONE ''America/Sao_Paulo'')::date - 5,''DD/MM/YYYY''), ''date_to'', to_char((now() AT TIME ZONE ''America/Sao_Paulo'')::date,''DD/MM/YYYY''), ''start_page'',1,''max_pages'',10), timeout_milliseconds := 150000 ); ');

SELECT cron.schedule('vendas-sync-pedidos-oben-2h', '5 */2 * * *', ' SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync'', headers := jsonb_build_object(''Content-Type'',''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'' LIMIT 1)), body := jsonb_build_object(''action'',''sync_pedidos'',''account'',''oben'', ''date_from'', to_char((now() AT TIME ZONE ''America/Sao_Paulo'')::date - 5,''DD/MM/YYYY''), ''date_to'', to_char((now() AT TIME ZONE ''America/Sao_Paulo'')::date,''DD/MM/YYYY''), ''start_page'',1,''max_pages'',10), timeout_milliseconds := 150000 ); ');

SELECT cron.schedule('visit-score-recalc-batch-nightly', '0 7 * * *', 'SELECT net.http_post( url := ''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/visit-score-recalc-batch'', headers := jsonb_build_object( ''Content-Type'', ''application/json'', ''x-cron-secret'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''CRON_SECRET'' LIMIT 1) ), timeout_milliseconds := 55000 );');

SELECT cron.schedule('weekly-algorithm-a-audit', '0 3 * * 0', ' SELECT net.http_post(url:=''https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/algorithm-a-audit'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-cron-secret'',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=''CRON_SECRET'')), body:=''{"triggered_by": "cron"}''::jsonb,timeout_milliseconds:=150000);');
