-- Validação pós-apply da 20261021031000_venda_cliente_ondas23.sql (read-only).
--   ~/.config/afiacao/psql-ro -X -tA -v ON_ERROR_STOP=1 -f db/validar-venda-ondas23.sql
-- Esperado: uma linha começando com ✅. Antes do apply: ❌ (nunca erro — a existência é checada primeiro).
SELECT CASE
  WHEN to_regprocedure('private.venda_lista_complemento(date)') IS NULL
    OR to_regprocedure('private.venda_lista_preco(date)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'venda_sugestao' AND column_name = 'preco_anterior')
    THEN '❌ FALTANDO — migration 20261021031000 não aplicada'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_gerar_lista(date,text)'))
         IS DISTINCT FROM '5abe897dbcaaf3b70351da896e35b566'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_minhas_sugestoes(date)'))
         IS DISTINCT FROM 'e38baeb57b7e19c815e45baa77a23810'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_fechar_desfechos(date)'))
         IS DISTINCT FROM '732f661febd3c3e3c0dde4eb18e90bdd'
    THEN '❌ corpo vivo divergente do da 20261021031000 (gerador, lista da farmer ou desfecho)'
  WHEN has_function_privilege('anon', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_fechar_desfechos(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.venda_lista_complemento(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.venda_lista_preco(date)', 'EXECUTE')
    OR has_function_privilege('anon', 'private.venda_lista_preco(date)', 'EXECUTE')
    THEN '❌ ACL errada (anon aberta, farmer sem a lista, ou gerador/listas privadas abertas)'
  WHEN NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.venda_sugestao'::regclass
                      AND conname = 'venda_sugestao_preco_anterior_ck' AND convalidated)
    THEN '❌ CHECK venda_sugestao_preco_anterior_ck ausente ou NOT VALID'
  ELSE '✅ ondas 2/3 no ar: gerador com complemento/preço, lista com ondas, desfecho de preço exige alta'
END AS status;
