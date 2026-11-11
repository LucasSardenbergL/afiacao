-- D15: duração real da promoção = duração do tick do cron (job 187, a cada 15 s) que contém promovido_em do run.
-- SÓ LEITURA (cron.job_run_details tem 45 MB; uma varredura, aceitável).
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
WITH tick AS (
  SELECT start_time, end_time, status FROM cron.job_run_details WHERE jobid = 187 AND start_time > now() - interval '7 days' AND end_time IS NOT NULL
), prom AS (
  SELECT r.id, r.sync_type, r.total_records, r.inserts, r.promovido_em FROM public.tint_sync_runs r WHERE r.promovido_em > now() - interval '7 days'
), j AS (
  SELECT t.start_time, t.end_time, extract(epoch FROM (t.end_time - t.start_time)) AS seg,
         count(p.id) AS n_prom, max(p.sync_type) AS tipo
  FROM tick t LEFT JOIN prom p ON p.promovido_em BETWEEN t.start_time AND t.end_time + interval '1 second'
  GROUP BY t.start_time, t.end_time
)
SELECT CASE WHEN n_prom = 0 THEN 'tick ocioso' ELSE 'tick com promoção '||tipo||' (n='||n_prom||')' END AS classe,
       count(*) AS ticks, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY seg)::numeric, 3) AS p50_s,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY seg)::numeric, 3) AS p90_s,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY seg)::numeric, 3) AS p99_s, round(max(seg)::numeric, 3) AS max_s,
       round(sum(seg)::numeric, 1) AS soma_s
FROM j GROUP BY 1 ORDER BY 2 DESC;
\echo '## ticks por dia (24 h móveis) e tempo total gasto no tick'
SELECT date_trunc('day', start_time AT TIME ZONE 'utc')::date, count(*), round(sum(extract(epoch FROM (end_time - start_time)))::numeric, 0) AS soma_s FROM cron.job_run_details WHERE jobid = 187 AND start_time > now() - interval '5 days' GROUP BY 1 ORDER BY 1 DESC;
SELECT '#FIM-OK';
