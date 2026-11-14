-- Extras para ler junto com a T1 (mesma janela T0 -> T1). SÓ LEITURA. T0 = 2026-11-11 17:20:24 UTC.
-- Ajuste :t0 e :t1 abaixo para os timestamps de TS dos dois arquivos de leitura.
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
\set t0 '2026-11-11 17:20:24+00'
\set t1 '2026-11-14 00:49:42+00'
\echo '## promoções do tint na janela (por tipo)'
SELECT sync_type, count(*), sum(total_records), sum(inserts) FROM public.tint_sync_runs WHERE promovido_em >= :'t0' AND promovido_em < :'t1' GROUP BY 1 ORDER BY 2 DESC;
\echo '## runs de fórmulas na janela (início, registros, inserts, fim da promoção)'
SELECT to_char(started_at AT TIME ZONE 'utc','MM-DD HH24:MI:SS'), total_records, inserts, to_char(promovido_em AT TIME ZONE 'utc','HH24:MI:SS') FROM public.tint_sync_runs WHERE sync_type='formulas' AND started_at >= :'t0' AND started_at < :'t1' ORDER BY started_at;
\echo '## duração do tick de promoção (job 187) na janela'
SELECT count(*), round(sum(extract(epoch FROM (end_time-start_time)))::numeric,1), round(max(extract(epoch FROM (end_time-start_time)))::numeric,1) FROM cron.job_run_details WHERE jobid=187 AND start_time >= :'t0' AND start_time < :'t1';
\echo '## jobs do cron com falha/timeout na janela (critério de decisão do Mini: job falhando por timeout)'
SELECT j.jobname, d.status, count(*) FROM cron.job_run_details d JOIN cron.job j USING (jobid) WHERE d.start_time >= :'t0' AND d.start_time < :'t1' AND d.status <> 'succeeded' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10;
SELECT '#FIM-OK';
