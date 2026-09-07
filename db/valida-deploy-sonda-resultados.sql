-- Validação pós-apply de 20260906180303_deploy_sonda_resultados.sql
-- Só catálogo: a tabela nova não é referenciada por nome numa query que precise parseá-la, então
-- ela diz ❌ em vez de abortar quando a migration ainda não pegou.
SELECT
  CASE WHEN (
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'deploy_sonda_resultados' AND c.relrowsecurity) = 1
    AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'deploy_sonda_resultados_colher') = 1
    AND (SELECT count(*) FROM cron.job
          WHERE jobname = 'deploy-sonda-resultados-colher' AND schedule = '*/12 * * * *') = 1
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
          AND policyname = 'deploy_sonda_resultados_select_staff') = 1
    AND NOT has_function_privilege('authenticated','public.deploy_sonda_resultados_colher()','EXECUTE')
    AND NOT has_table_privilege('anon','public.deploy_sonda_resultados','SELECT')
  ) THEN '✅ deploy_sonda_resultados aplicada: tabela com RLS, policy de staff, coletor FECHADO, cron */12'
  ELSE '❌ FALTANDO ou INCOMPLETA — a migration não pegou (ou pegou pela metade)' END AS status;
