-- Validação pós-apply da migration 20261113130000_venda_contribuicao_cliente (read-only; psql-ro ou SQL Editor).
-- Lê CATÁLOGO, nunca invoca as funções (database.md §4: invocar sob psql-ro dá 42501 do próprio REVOKE).
-- Esperado: 6 linhas ✅.
SELECT item, CASE WHEN ok THEN '✅' ELSE '❌' END AS status
  FROM (VALUES
    ('motor existe',
     to_regprocedure('private.venda_contribuicao_linhas(date,date)') IS NOT NULL),
    ('porta existe e e SECURITY DEFINER',
     COALESCE((SELECT p.prosecdef FROM pg_proc p
                WHERE p.oid = to_regprocedure('public.venda_contribuicao(text,text,text,text,integer,integer)')), false)),
    ('motor fechado ao browser (anon e authenticated sem EXECUTE)',
     to_regprocedure('private.venda_contribuicao_linhas(date,date)') IS NOT NULL
     AND NOT has_function_privilege('anon', 'private.venda_contribuicao_linhas(date,date)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'private.venda_contribuicao_linhas(date,date)', 'EXECUTE')),
    ('porta: anon nao, authenticated sim',
     to_regprocedure('public.venda_contribuicao(text,text,text,text,integer,integer)') IS NOT NULL
     AND NOT has_function_privilege('anon', 'public.venda_contribuicao(text,text,text,text,integer,integer)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.venda_contribuicao(text,text,text,text,integer,integer)', 'EXECUTE')),
    ('porta com os DOIS gates (cap_custo_ler e master)',
     COALESCE((SELECT pg_get_functiondef(p.oid) ~ 'IF NOT private\.cap_custo_ler\('
                  AND pg_get_functiondef(p.oid) ~ 'IF NOT public\.has_role\(\(SELECT auth\.uid\(\)\), ''master''::public\.app_role\)'
                 FROM pg_proc p
                WHERE p.oid = to_regprocedure('public.venda_contribuicao(text,text,text,text,integer,integer)')), false)),
    ('motor sem cmc_ledger e com a exclusividade contra todos os pedidos',
     COALESCE((SELECT pg_get_functiondef(p.oid) !~ 'cmc_ledger'
                  AND pg_get_functiondef(p.oid) ~ 'pedido_todos'
                  AND pg_get_functiondef(p.oid) ~ 'cliente_ok'
                 FROM pg_proc p
                WHERE p.oid = to_regprocedure('private.venda_contribuicao_linhas(date,date)')), false))
  ) v(item, ok);
