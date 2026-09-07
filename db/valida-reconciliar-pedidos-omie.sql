-- Validação pós-apply de 20260830190000_reconciliar_pedidos_omie.sql (read-only).
-- ⚠️ Duas armadilhas já pagas nesta query, ambas da MESMA classe (só o ramo negativo tinha sido
-- exercitado): (1) `pg_get_function_identity_arguments` inclui os NOMES dos parâmetros, então
-- comparar com 'jsonb, text[], timestamptz' dava FALSO VERMELHO com a migration aplicada;
-- (2) `::regprocedure` LANÇA quando a função não existe — a query erraria em vez de dizer ❌.
-- `to_regprocedure` devolve NULL e deixa o CASE responder.
SELECT
  CASE WHEN (
    SELECT p.oid IS NOT NULL
       AND p.prosecdef = false
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.reconciliar_pedidos_omie(jsonb, text[], timestamptz)')
  )
  AND to_regprocedure('public.reconciliar_pedidos_omie(jsonb, text[])') IS NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sales_orders'
       AND column_name = 'omie_reconciliado_em'
  )
  THEN '✅ RPC (jsonb,text[],timestamptz) INVOKER + só service_role + coluna omie_reconciliado_em + sem sobrecarga velha'
  ELSE '❌ FALTANDO, grant errado, ou a sobrecarga de 2 args sobreviveu' END AS status;
