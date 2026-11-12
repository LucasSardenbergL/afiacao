-- B5: quem lê cron.job_run_details (corpos vivos), dono do schema, índices, retenção, tamanho. SÓ LEITURA.
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
\echo '## funções que citam job_run_details (prosrc vivo)'
SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', length(p.prosrc), md5(p.prosrc), pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosrc ILIKE '%job_run_details%' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1;
\echo '## views/matviews que citam job_run_details'
SELECT n.nspname||'.'||c.relname, c.relkind, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ILIKE '%job_run_details%' ORDER BY 1;
\echo '## views v_cron_* (todas) e o que leem'
SELECT n.nspname||'.'||c.relname, (pg_get_viewdef(c.oid) ILIKE '%job_run_details%') AS le_jrd FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('v','m') AND c.relname LIKE 'v\_cron\_%' ORDER BY 1;
\echo '## dependências pg_depend/pg_rewrite de views sobre cron.job_run_details'
SELECT DISTINCT n.nspname||'.'||v.relname FROM pg_rewrite r JOIN pg_depend d ON d.objid=r.oid AND d.classid='pg_rewrite'::regclass JOIN pg_class v ON v.oid=r.ev_class JOIN pg_namespace n ON n.oid=v.relnamespace WHERE d.refobjid='cron.job_run_details'::regclass AND v.oid <> d.refobjid;
\echo '## schema cron / tabela: dono, ACL, índices, tamanho'
SELECT 'schema', nspname, pg_get_userbyid(nspowner), nspacl::text FROM pg_namespace WHERE nspname='cron';
SELECT 'tabela', relname, pg_get_userbyid(relowner), relacl::text, relpages, reltuples::bigint, pg_size_pretty(pg_total_relation_size(oid)), pg_size_pretty(pg_relation_size(oid)) FROM pg_class WHERE oid='cron.job_run_details'::regclass;
SELECT 'indice', indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid='cron.job_run_details'::regclass;
SELECT 'privilégios claude_ro', has_table_privilege('claude_ro','cron.job_run_details','SELECT'), 'CREATE no schema cron: postgres=', has_schema_privilege('postgres','cron','CREATE'), 'claude_ro=', has_schema_privilege('claude_ro','cron','CREATE');
SELECT 'postgres é membro de quem é dono?', pg_has_role('postgres', 'supabase_admin', 'USAGE'), pg_has_role('postgres', 'postgres', 'USAGE');
\echo '## contadores e cobertura de dados'
SELECT 'stat', seq_scan, seq_tup_read, idx_scan, n_live_tup, n_dead_tup, n_tup_ins, n_tup_del, last_autovacuum, autovacuum_count, last_vacuum FROM pg_stat_all_tables WHERE relid='cron.job_run_details'::regclass;
SELECT 'statio', heap_blks_read, heap_blks_hit, toast_blks_read, toast_blks_hit FROM pg_statio_all_tables WHERE relid='cron.job_run_details'::regclass;
SELECT 'janela', min(start_time), max(start_time), count(*) FROM cron.job_run_details;
SELECT 'por job', jobid, count(*), min(start_time) FROM cron.job_run_details GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8;
\echo '## retenção'
SELECT 'job', jobid, jobname, schedule, active, left(command, 200) FROM cron.job WHERE command ILIKE '%job_run_details%';
SELECT '#FIM-OK';
