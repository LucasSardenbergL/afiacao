-- Validação pós-apply de 20260726130000_vendas_sync_semear_janela.sql (read-only).
-- Lê CATÁLOGO, nunca invoca (FU4-E: invocar mente nos dois sentidos — NULL sem cast
-- não resolve assinatura e o REVOKE vira 'permission denied' que parece falha).
-- Corpo avaliado com comentários REMOVIDOS (lição #1472/#1488: assert sobre corpo
-- cru casa prosa de comentário). Executada contra banco bom E sabotado no harness
-- db/test-vendas_sync_semear_janela.sh (lição #1490/#1501: validador sem dente).
SELECT CASE
  WHEN to_regprocedure('public.vendas_sync_semear_janela(text,date,date)') IS NULL
    THEN '❌ FALTANDO — migration nao aplicada'
  WHEN NOT has_function_privilege('authenticated', 'public.vendas_sync_semear_janela(text,date,date)', 'EXECUTE')
    THEN '❌ authenticated sem EXECUTE (GRANT nao pegou)'
  WHEN has_function_privilege('anon', 'public.vendas_sync_semear_janela(text,date,date)', 'EXECUTE')
    THEN '❌ anon com EXECUTE (REVOKE nao pegou)'
  WHEN regexp_replace(pg_get_functiondef(to_regprocedure('public.vendas_sync_semear_janela(text,date,date)')), '--[^\n]*', '', 'g')
       !~ 'IF v_uid IS NULL\s+OR NOT \(COALESCE\(public\.has_role\(v_uid, ''employee''::public\.app_role\), false\)'
    THEN '❌ corpo sem o gate staff fail-closed'
  WHEN regexp_replace(pg_get_functiondef(to_regprocedure('public.vendas_sync_semear_janela(text,date,date)')), '--[^\n]*', '', 'g')
       !~ 'ON CONFLICT \(account, date_from, date_to\) DO NOTHING'
    THEN '❌ corpo sem o ON CONFLICT DO NOTHING (risco de clobber)'
  ELSE '✅ vendas_sync_semear_janela aplicada (gate staff + grants + DO NOTHING ok)'
END AS status;
