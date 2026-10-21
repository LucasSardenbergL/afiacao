-- Validação read-only (psql-ro) da Task 7 — painel do founder (20261020235000) + sensor no ledger.
-- Esperado: uma linha começando com ✅.
SELECT CASE WHEN
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'venda_painel') = 1
  AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_painel(date,date)')
               AND p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public, pg_temp'])
  AND NOT has_function_privilege('anon', 'public.venda_painel(date,date)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.venda_painel(date,date)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.venda_painel(date,date)', 'EXECUTE')
  AND pg_get_functiondef(to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')) LIKE '%''venda.painel_aberto''%'
THEN '✅ venda_painel master-only (SECURITY DEFINER, STABLE, ACL fechada) + ledger aceita venda.painel_aberto'
ELSE '❌ FALTANDO — venda_painel ausente/ACL aberta ou ledger sem venda.painel_aberto' END AS status;
