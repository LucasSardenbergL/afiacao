-- B5: linhas dos corpos vivos que leem cron.job_run_details (contexto ±2 linhas), e quem chama cada função no cron. SÓ LEITURA.
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
WITH f AS (
  SELECT p.proname, l.n, l.t, count(*) OVER (PARTITION BY p.proname) k
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  CROSS JOIN LATERAL regexp_split_to_table(p.prosrc, E'\n') WITH ORDINALITY AS l(t, n)
  WHERE ns.nspname='public' AND p.proname IN ('_data_health_compute','analytics_outbox_claim','get_carteira_saude','radar_avisar_vendedores','tint_promocao_watchdog','tint_watchdog_corante_check','tint_watchdog_corante_vigia_check')
    AND l.t ILIKE '%job_run_details%'
)
SELECT proname, n, left(btrim(t), 220) FROM f ORDER BY proname, n;
\echo '## views v_cron_*'
SELECT 'v_cron_jobs_falhas', pg_get_viewdef('public.v_cron_jobs_falhas'::regclass);
SELECT 'v_cron_jobs_status', pg_get_viewdef('public.v_cron_jobs_status'::regclass);
\echo '## leitores das views v_cron_* (funções)'
SELECT p.proname, count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.prosrc ILIKE '%v_cron_jobs_%' GROUP BY 1;
\echo '## crons que chamam cada função (jobid, schedule, ativo)'
SELECT j.jobid, j.jobname, j.schedule, j.active, left(regexp_replace(j.command, '\s+', ' ', 'g'), 160) FROM cron.job j WHERE j.command ~ '(_data_health_compute|data_health_watchdog|analytics_outbox_claim|get_carteira_saude|radar_avisar_vendedores|tint_promocao_watchdog|tint_watchdog_corante_check|tint_watchdog_corante_vigia_check|v_cron_jobs)' ORDER BY j.jobid;
SELECT '#FIM-OK';
