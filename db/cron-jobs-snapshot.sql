-- cron-jobs-snapshot.sql — exporta cron.job como TSV ESTÁVEL para supabase/cron-jobs-snapshot.tsv (M-37).
--
-- O pg_dump do db/refresh-snapshot.sh é --schema-only: ele não leva as LINHAS de cron.job, então
-- um DR recriaria o schema sem os ~100 crons de prod (o runbook falava em 33). Este arquivo é a
-- parte do DR que o dump não cobre. Rodado pelo refresh (via psql-ro, read-only).
--
-- Formato: 1ª linha = cabeçalho; uma linha por job, ordenada por jobname; última linha =
-- marcador de fim "#fim<TAB><n>" (n = nº de jobs). Sem o marcador, a saída foi truncada.
-- O command é escapado (\ → \\, quebra de linha → \n, CR → \r, TAB → \t) para caber numa linha.
-- jobid NÃO entra: muda a cada re-agendamento e só geraria diff ruidoso.
SELECT linha FROM (
  SELECT 0 AS ordem, '' AS chave,
         'jobname' || E'\t' || 'schedule' || E'\t' || 'active' || E'\t' || 'username' || E'\t' || 'database' || E'\t' || 'command' AS linha
  UNION ALL
  SELECT 1, jobname,
         jobname || E'\t' || schedule || E'\t' || active::text || E'\t' || coalesce(username, '') || E'\t' ||
         coalesce(database, '') || E'\t' ||
         replace(replace(replace(replace(command, E'\\', E'\\\\'), E'\n', E'\\n'), E'\r', E'\\r'), E'\t', E'\\t')
    FROM cron.job
  UNION ALL
  SELECT 2, '', '#fim' || E'\t' || (SELECT count(*) FROM cron.job)::text
) s
ORDER BY ordem, chave COLLATE "C";
