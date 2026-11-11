-- Lote 5 do plano v9 — leitura do delta de 24 h. SÓ LEITURA (pg_stat_*). Rodar:
--   ~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -f leitura-24h.sql > leitura-T<n>.out
-- Conferir exit 0 e a última linha '#FIM-OK'.
\pset format unaligned
\pset fieldsep '|'
\pset tuples_only on
SELECT 'TS', now() AT TIME ZONE 'utc', pg_postmaster_start_time() AT TIME ZONE 'utc';
SELECT 'DB', blks_read, blks_hit, temp_bytes, temp_files, tup_returned, tup_fetched, xact_commit, coalesce(stats_reset::text,'') FROM pg_stat_database WHERE datname=current_database();
SELECT 'IO', backend_type, object, context, coalesce(reads,0), coalesce(reads,0)*coalesce(op_bytes,0), coalesce(writes,0), coalesce(writes,0)*coalesce(op_bytes,0), coalesce(hits,0), coalesce(evictions,0), coalesce(extends,0) FROM pg_stat_io WHERE coalesce(reads,0)+coalesce(writes,0)+coalesce(hits,0)+coalesce(extends,0) > 0;
SELECT 'WAL', wal_records, wal_fpi, wal_bytes, wal_buffers_full FROM pg_stat_wal;
SELECT 'BG', buffers_clean, maxwritten_clean, buffers_alloc FROM pg_stat_bgwriter;
SELECT 'CK', num_timed, num_requested, buffers_written, write_time::bigint, sync_time::bigint FROM pg_stat_checkpointer;
SELECT 'T', schemaname||'.'||relname, coalesce(heap_blks_read,0), coalesce(idx_blks_read,0), coalesce(toast_blks_read,0)+coalesce(tidx_blks_read,0), coalesce(heap_blks_hit,0), coalesce(idx_blks_hit,0) FROM pg_statio_all_tables WHERE schemaname NOT IN ('pg_toast','information_schema');
SELECT 'S', s.schemaname||'.'||s.relname, seq_scan, seq_tup_read, idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, n_dead_tup, n_live_tup FROM pg_stat_all_tables s WHERE schemaname NOT IN ('pg_toast','information_schema');
SELECT 'I', schemaname||'.'||indexrelname, coalesce(idx_blks_read,0), coalesce(idx_blks_hit,0) FROM pg_statio_all_indexes WHERE schemaname NOT IN ('pg_toast','information_schema','pg_catalog') AND coalesce(idx_blks_read,0) > 0;
SELECT 'IX', schemaname||'.'||indexrelname, idx_scan, pg_relation_size(indexrelid) FROM pg_stat_all_indexes WHERE schemaname='public' AND (indexrelname LIKE 'idx_radar_lista%' OR indexrelname LIKE '%titular_mei%');
SELECT '#FIM-OK';
