-- Validação pós-apply da 20261020181743_venda_cliente_gerador.sql (read-only).
--   ~/.config/afiacao/psql-ro -X -tA -v ON_ERROR_STOP=1 -f db/validar-venda-gerador.sql
-- Esperado: uma linha começando com ✅. Antes do apply: ❌ (nunca erro — a existência é checada primeiro).
SELECT CASE
  WHEN to_regprocedure('public.venda_cidades_alvo(date)') IS NULL
    OR to_regprocedure('public.venda_gerar_lista(date,text)') IS NULL
    OR to_regprocedure('public.venda_reconstruir_historico(date,date)') IS NULL
    OR to_regprocedure('public.venda_avaliar_ondas(date)') IS NULL
    OR to_regprocedure('private.venda_lista_calc(date)') IS NULL
    OR to_regprocedure('private.venda_city_uf(text)') IS NULL
    OR to_regclass('public.venda_gerador_execucao') IS NULL
    OR to_regclass('public.venda_onda_log') IS NULL
    THEN '❌ FALTANDO — migration 20261020181743 não aplicada'
  WHEN has_function_privilege('anon', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_reconstruir_historico(date,date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_avaliar_ondas(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_cidades_alvo(date)', 'EXECUTE')
    THEN '❌ ACL aberta para anon/authenticated'
  WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.venda_gerador_execucao'))
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.venda_onda_log'))
    THEN '❌ RLS desligada numa tabela nova'
  WHEN (SELECT count(*) FROM cron.job WHERE jobname = 'venda-gerador' AND schedule = '15 8 * * *' AND active) <> 1
    THEN '❌ cron venda-gerador ausente ou divergente'
  ELSE '✅ gerador D-1 no ar: 4 RPCs fechadas, 2 tabelas com RLS, cron 08:15 UTC'
END AS status;
