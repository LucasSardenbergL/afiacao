-- D15: perfil da promoção do tint (corpo vivo + runs). SÓ LEITURA. Não chama tint_promote_sync_run.
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
\echo '## CREATE TEMP no corpo vivo (nome, ON COMMIT)'
SELECT m[1] AS tabela, (m[2] ILIKE '%ON COMMIT DROP%') AS on_commit_drop
FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid='public.tint_promote_sync_run(uuid)'::regprocedure), 'CREATE\s+TEMP(?:ORARY)?\s+TABLE\s+(\w+)([^;]*);', 'gi') AS m;
\echo '## runs por tipo (7 d): n, promovidos, duração do sync, promoção (promovido_em - completed_at), total_records'
SELECT sync_type, promocao_status, count(*), round(avg(duration_ms)) AS sync_ms_med, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (promovido_em - completed_at))*1000)::numeric) AS promo_ms_p50, round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (promovido_em - completed_at))*1000)::numeric) AS promo_ms_p90, round(avg(total_records)) AS recs
FROM public.tint_sync_runs WHERE started_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY 3 DESC;
\echo '## runs por dia (catalogs) e por hora no último dia'
SELECT date_trunc('day', started_at AT TIME ZONE 'utc')::date, sync_type, count(*), sum(total_records) FROM public.tint_sync_runs WHERE started_at > now() - interval '5 days' GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC;
\echo '## últimos 12 runs promovidos (para casar com janela de contadores)'
SELECT to_char(started_at AT TIME ZONE 'utc','MM-DD HH24:MI:SS'), sync_type, status, promocao_status, duration_ms, total_records, inserts, updates, to_char(promovido_em AT TIME ZONE 'utc','HH24:MI:SS.MS') FROM public.tint_sync_runs ORDER BY started_at DESC LIMIT 12;
SELECT '#FIM-OK';
