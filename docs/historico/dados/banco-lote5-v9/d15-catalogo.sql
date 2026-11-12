-- D15: tamanho e saúde dos catálogos que a promoção do tint churna. SÓ LEITURA (pg_relation_size lê só metadado).
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
SELECT s.relname, pg_size_pretty(pg_relation_size(c.oid)) AS heap, pg_size_pretty(pg_indexes_size(c.oid)) AS idx, s.n_live_tup, s.n_dead_tup, s.n_tup_ins, s.n_tup_del, s.vacuum_count, s.autovacuum_count, s.last_autovacuum::timestamp(0)
FROM pg_stat_sys_tables s JOIN pg_class c ON c.oid = s.relid
WHERE s.relname IN ('pg_class','pg_attribute','pg_type','pg_depend','pg_index') ORDER BY pg_relation_size(c.oid) DESC;
SELECT 'temp_buffers', current_setting('temp_buffers'), 'work_mem', current_setting('work_mem'), 'autovacuum_naptime', current_setting('autovacuum_naptime');
SELECT '#FIM-OK';
