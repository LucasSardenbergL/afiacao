-- Validação pós-apply da migration 20260906151204_deploy_sonda_cron_fail_closed.sql
-- Só toca CATÁLOGO (existe sempre) e, para a contagem da semente, usa `query_to_xml`, cuja query
-- é uma STRING: sem isso, referenciar a tabela nova faria o Postgres ABORTAR no parse quando ela
-- ainda não existe — e um ERROR se lê como "problema no psql", não como "a migration não pegou".
SELECT
  CASE WHEN (
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('deploy_sonda_alvos','deploy_sonda_disparos')
        AND c.relrowsecurity) = 2
    AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'deploy_sonda_disparar') = 1
    AND (SELECT count(*) FROM cron.job
          WHERE jobname = 'deploy-sonda-cron' AND schedule = '37 */2 * * *'
            AND command LIKE '%deploy_sonda_disparar%') = 1
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
          AND policyname IN ('deploy_sonda_alvos_select_staff','deploy_sonda_disparos_select_staff')) = 2
    AND CASE WHEN to_regclass('public.deploy_sonda_alvos') IS NULL THEN 0
             ELSE (xpath('/row/c/text()',
                     query_to_xml('SELECT count(*) AS c FROM public.deploy_sonda_alvos WHERE ativo',
                                  false, true, '')))[1]::text::int
        END >= 3
    AND NOT has_function_privilege('authenticated','public.deploy_sonda_disparar(text[])','EXECUTE')
    AND NOT has_function_privilege('service_role','public.deploy_sonda_disparar(text[])','EXECUTE')
    AND NOT has_table_privilege('anon','public.deploy_sonda_alvos','SELECT')
  ) THEN '✅ sonda por cron aplicada: 2 tabelas com RLS, 2 policies, dispatcher FECHADO, cron 37 */2, >=3 alvos ativos'
  ELSE '❌ FALTANDO ou INCOMPLETA — a migration não pegou (ou pegou pela metade)' END AS status;
