-- B5: amostra do contador de seq scans de cron.job_run_details a cada 5 s (para casar o incremento com o minuto do cron). SÓ LEITURA.
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
SELECT to_char(clock_timestamp() AT TIME ZONE 'utc','HH24:MI:SS'), seq_scan, seq_tup_read, idx_scan, n_tup_del FROM pg_stat_all_tables WHERE relid='cron.job_run_details'::regclass \watch i=5 c=140
SELECT '#FIM-OK';
