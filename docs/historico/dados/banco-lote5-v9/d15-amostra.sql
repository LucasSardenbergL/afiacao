-- D15: série de contadores a cada 3 s, cobrindo rajadas de promoção do tint (tint_promocao_tick a cada 15 s;
-- 5 promoções de 'catalogs' a cada ~10 min). SÓ LEITURA: não chama a promoção, só lê pg_stat_*.
-- Colunas: hora | io temp relation por backend_type (reads/writes/hits/evictions/extends) | wal_records/wal_fpi/wal_bytes |
--          catálogo ins/del/dead de pg_class,pg_attribute,pg_type,pg_depend,pg_index | xact_commit/temp_bytes | io 'relation' normal (reads/hits)
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
SELECT to_char(clock_timestamp() AT TIME ZONE 'utc','HH24:MI:SS'),
  (SELECT coalesce(string_agg(backend_type||':'||coalesce(reads,0)||'/'||coalesce(writes,0)||'/'||coalesce(hits,0)||'/'||coalesce(evictions,0)||'/'||coalesce(extends,0), ',' ORDER BY backend_type),'-') FROM pg_stat_io WHERE object='temp relation' AND coalesce(reads,0)+coalesce(writes,0)+coalesce(hits,0)+coalesce(extends,0)>0),
  (SELECT wal_records||'/'||wal_fpi||'/'||wal_bytes FROM pg_stat_wal),
  (SELECT string_agg(relname||':'||n_tup_ins||'/'||n_tup_del||'/'||n_dead_tup, ',' ORDER BY relname) FROM pg_stat_sys_tables WHERE relname IN ('pg_class','pg_attribute','pg_type','pg_depend','pg_index')),
  (SELECT xact_commit||'/'||temp_bytes FROM pg_stat_database WHERE datname=current_database()),
  (SELECT sum(coalesce(reads,0))||'/'||sum(coalesce(hits,0)) FROM pg_stat_io WHERE object='relation')
\watch i=3 c=330
SELECT '#FIM-OK';
