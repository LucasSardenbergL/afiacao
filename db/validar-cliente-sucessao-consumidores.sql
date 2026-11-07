-- validar-cliente-sucessao-consumidores.sql — conferência READ-ONLY, pós-apply, da
-- 20261108000000_cliente_sucessao_consumidores.sql (sucessor declarado, entrega 3 PR C).
-- Roda no SQL Editor ou no psql-ro. Só lê CATÁLOGO (não invoca nenhuma função: sob psql-ro o REVOKE daria
-- "permission denied", um falso "não aplicou"). Esperado: 6 linhas, todas ✅. Exercitada pela prova
-- db/test-cliente-sucessao-consumidores.sh (✅ contra a migration real).
WITH nova(sig) AS (VALUES ('public.venda_heranca_comprador(uuid)'), ('public.cliente_sucessao_plano_itens(uuid)')),
c(n, nome, ok) AS (
  SELECT 1, 'private._venda_sugestoes_json é o corpo NOVO (expõe a origem da herança) — md5 6e26a836…',
         (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)'))
           = '6e26a8360dbfc2e0af9559d6a75da893'
  UNION ALL SELECT 2, 'as RPCs da lista seguem com os corpos de antes (chamam o helper)',
         (SELECT string_agg(md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
           WHERE p.oid IN (to_regprocedure('public.get_venda_sugestoes_for(uuid,date)'),
                           to_regprocedure('public.venda_minhas_sugestoes(date)')))
           = '2cd5333ed0750a7f0b4afae29a97e650,ca1ece0e8e887d2b3e66d9fc757f1b3f'
  UNION ALL SELECT 3, 'as 2 RPCs novas existem, STABLE e SECURITY DEFINER',
         (SELECT count(*) FROM nova JOIN pg_proc p ON p.oid = to_regprocedure(nova.sig)
           WHERE p.prosecdef AND p.provolatile = 's') = 2
  UNION ALL SELECT 4, 'RPCs novas: anon e PUBLIC fechados, authenticated aberto',
         NOT EXISTS (SELECT 1 FROM nova WHERE to_regprocedure(nova.sig) IS NULL
                        OR has_function_privilege('anon', nova.sig, 'EXECUTE')
                        OR NOT has_function_privilege('authenticated', nova.sig, 'EXECUTE'))
         AND NOT EXISTS (SELECT 1 FROM nova JOIN pg_proc p ON p.oid = to_regprocedure(nova.sig),
                                aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                          WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  UNION ALL SELECT 5, 'o gate da tela do plano é gestor (pode_ver_carteira_completa); o da herança, staff + carteira',
         (SELECT p.prosrc ~ 'pode_ver_carteira_completa' FROM pg_proc p WHERE p.oid = to_regprocedure('public.cliente_sucessao_plano_itens(uuid)'))
         AND (SELECT p.prosrc ~ 'cap_carteira_ler' AND p.prosrc ~ 'requer perfil staff' FROM pg_proc p
               WHERE p.oid = to_regprocedure('public.venda_heranca_comprador(uuid)'))
  UNION ALL SELECT 6, 'a base do PR B segue (gerador md5 3b93a5e8…, colunas da origem em venda_sugestao)',
         (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_gerar_lista(date,text)'))
           = '3b93a5e827ebc78af6dd325c5b5b0c7f'
         AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venda_sugestao'
               AND column_name IN ('sucessao_origem', 'valor_ref_referencia_origem')) = 2
)
SELECT n, CASE WHEN ok THEN '✅' ELSE '❌' END AS status, nome FROM c ORDER BY n;
