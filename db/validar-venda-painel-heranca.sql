-- validar-venda-painel-heranca.sql — conferência READ-ONLY, pós-apply, da 20261108010000_venda_painel_heranca.sql
-- (sucessor declarado, entrega 3: o painel de gestão separa a parte herdada).
-- Roda no SQL Editor ou no psql-ro. Só lê CATÁLOGO (não invoca a função: ela é master-only e, sob psql-ro, daria
-- "permission denied", um falso "não aplicou"). Esperado: 4 linhas, todas ✅.
WITH f AS (SELECT p.* FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_painel(date,date)')),
c(n, nome, ok) AS (
  SELECT 1, 'public.venda_painel é o corpo NOVO (separa as herdadas) — md5 2b3f2c1b…',
         (SELECT md5(prosrc) FROM f) = '2b3f2c1b9af99c6dcc34f413f9534c54'
  UNION ALL SELECT 2, 'continua STABLE SECURITY DEFINER com o gate master',
         (SELECT prosecdef AND provolatile = 's' AND prosrc LIKE '%has_role(v_uid, ''master''::public.app_role)%' FROM f)
  UNION ALL SELECT 3, 'ACL: anon e PUBLIC fechados, authenticated aberto',
         NOT has_function_privilege('anon', 'public.venda_painel(date,date)', 'EXECUTE')
         AND NOT has_function_privilege('public', 'public.venda_painel(date,date)', 'EXECUTE')
         AND has_function_privilege('authenticated', 'public.venda_painel(date,date)', 'EXECUTE')
  UNION ALL SELECT 4, 'a base do PR B segue (coluna venda_sugestao.sucessao_origem jsonb)',
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venda_sugestao'
                  AND column_name = 'sucessao_origem' AND data_type = 'jsonb')
)
SELECT n, CASE WHEN ok THEN '✅' ELSE '❌' END AS status, nome FROM c ORDER BY n;
