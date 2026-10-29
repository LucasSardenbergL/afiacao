-- Validação pós-apply da 20261028220003_venda_lista_acesso.sql (read-only).
--   ~/.config/afiacao/psql-ro -X -tA -v ON_ERROR_STOP=1 -f db/validar-venda-lista-acesso.sql
-- Esperado: uma linha começando com ✅. Antes do apply: ❌ (nunca erro — a existência é checada primeiro).
SELECT CASE
  WHEN to_regclass('public.venda_lista_acesso') IS NULL
    THEN '❌ FALTANDO — migration 20261028220003 não aplicada (venda_lista_acesso ausente)'
  WHEN COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_minhas_sugestoes(date)')), '')
         <> 'ca1ece0e8e887d2b3e66d9fc757f1b3f'
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.venda_minhas_sugestoes(date)'::regprocedure
                    AND prosecdef AND provolatile = 'v' AND proconfig @> ARRAY['search_path=public, pg_temp'])
    THEN '❌ venda_minhas_sugestoes não é o corpo da 20261028220003 (ou perdeu DEFINER/VOLATILE/search_path)'
  WHEN COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)')), '')
         <> '288ace38a44f0a70bffe5426a0ba44a3'
    OR COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.get_venda_sugestoes_for(uuid,date)')), '')
         <> '2cd5333ed0750a7f0b4afae29a97e650'
    THEN '❌ helper/get_venda_sugestoes_for mudaram (a lente pode estar gravando ou a saída divergiu)'
  WHEN has_function_privilege('anon', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR has_function_privilege('public', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    THEN '❌ ACL de venda_minhas_sugestoes (anon/PUBLIC sem, authenticated com)'
  WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.venda_lista_acesso'))
    OR (SELECT count(*) FROM pg_policy WHERE polrelid = to_regclass('public.venda_lista_acesso')) <> 1
    OR has_table_privilege('anon', 'public.venda_lista_acesso', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('authenticated', 'public.venda_lista_acesso', 'INSERT,UPDATE,DELETE,TRUNCATE')
    THEN '❌ venda_lista_acesso sem RLS / policy extra / escrita aberta a anon ou authenticated'
  ELSE '✅ 20261028220003 aplicada: sensor venda_lista_acesso no ar, RPC VOLATILE gravando, ACL e RLS fechadas'
END AS status;
