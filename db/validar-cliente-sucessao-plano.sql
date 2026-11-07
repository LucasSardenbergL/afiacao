-- validar-cliente-sucessao-plano.sql — conferência READ-ONLY, pós-apply, da 20261107210000_cliente_sucessao_plano_rateio.sql.
-- Roda no SQL Editor ou no psql-ro. Só lê CATÁLOGO (não invoca nenhuma função: sob psql-ro o REVOKE daria
-- "permission denied", um falso "não aplicou"). Esperado: 12 linhas, todas ✅. Exercitada pela prova
-- db/test-cliente-sucessao-plano.sh (✅ contra a migration real).
WITH t(nome) AS (VALUES ('public.cliente_sucessao_plano_revisoes'), ('public.cliente_sucessao_plano_regras'),
                        ('public.venda_sugestao_substituida'), ('private.venda_sugestoes_reprocesso_fila'),
                        ('private.cliente_sucessao_estado_visto')),
rpc(sig) AS (VALUES ('public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text)'),
                    ('public.cliente_sucessao_plano_revogar(uuid,integer,text)'),
                    ('public.cliente_sucessao_plano_do_evento(uuid)')),
priv(sig) AS (VALUES ('private.historico_consumo_efetivo(date)'), ('private.historico_compradores_encerrados(date)'),
                     ('private.venda_recompra_efetiva_em(date)'), ('private.venda_situacao_efetiva_em(date)'),
                     ('private.venda_lista_calc_efetiva(date)'), ('private.venda_sugestoes_reprocessar_sucessao(uuid,text,jsonb,integer)'),
                     ('private.cliente_sucessao_assinaturas(date)'),
                     ('private.venda_sugestoes_drenar_reprocesso()'), ('private.cliente_sucessao_plano_imutavel()'),
                     ('private.venda_sugestao_substituida_imutavel()')),
fato(sig, m) AS (VALUES ('private.venda_linhas_pedido(date)', 'a7ff6d1c894aea2e16483b5084a097a1'),
                        ('public.venda_recompra_em(date)', '2b43b81254a7c13c019c65fae41ea90a'),
                        ('public.venda_situacao_em(date)', 'e96cf9c931a13b209bb3017b8c4743ac'),
                        ('private.venda_lista_calc(date)', 'cd7a7184e4b07d3665b1c39f70a3ac59')),
c(n, nome, ok) AS (
  SELECT 1, 'as 5 tabelas novas existem com RLS ligada',
         (SELECT count(*) FROM t JOIN pg_class k ON k.oid = to_regclass(t.nome) WHERE k.relrowsecurity) = 5
  UNION ALL SELECT 2, 'tabelas novas fechadas ao JWT (anon/authenticated sem privilégio algum)',
         NOT EXISTS (SELECT 1 FROM t WHERE to_regclass(t.nome) IS NULL
                        OR has_table_privilege('authenticated', t.nome, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                        OR has_table_privilege('anon', t.nome, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
  UNION ALL SELECT 3, 'service_role só LÊ as tabelas novas',
         NOT EXISTS (SELECT 1 FROM t WHERE to_regclass(t.nome) IS NULL
                        OR has_table_privilege('service_role', t.nome, 'INSERT,UPDATE,DELETE,TRUNCATE'))
  UNION ALL SELECT 4, 'triggers de imutabilidade ligados (plano 2×2 + arquivo 2)',
         (SELECT count(*) FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
             AND g.tgrelid IN (to_regclass('public.cliente_sucessao_plano_revisoes'), to_regclass('public.cliente_sucessao_plano_regras'),
                               to_regclass('public.venda_sugestao_substituida'))) = 6
  UNION ALL SELECT 5, 'venda_sugestao: sucessao_origem + valor_ref_referencia_origem (NOT NULL) + 2 CHECKs validados',
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venda_sugestao' AND column_name = 'sucessao_origem')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venda_sugestao'
                        AND column_name = 'valor_ref_referencia_origem' AND is_nullable = 'NO')
         AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass AND convalidated
                AND conname IN ('venda_sugestao_sucessao_origem_ck', 'venda_sugestao_ref_origem_ck')) = 2
  UNION ALL SELECT 6, 'venda_gerar_lista é o corpo NOVO (lê a lista efetiva e drena a fila) — md5 3b93a5e8…',
         (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_gerar_lista(date,text)'))
           = '3b93a5e827ebc78af6dd325c5b5b0c7f'
  UNION ALL SELECT 7, 'venda_gerar_lista: EXECUTE só service_role (nem anon nem authenticated)',
         NOT has_function_privilege('anon', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
         AND has_function_privilege('service_role', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
  UNION ALL SELECT 8, 'as 3 RPCs: SECURITY DEFINER com o gate gestor/master',
         (SELECT count(*) FROM rpc JOIN pg_proc p ON p.oid = to_regprocedure(rpc.sig)
           WHERE p.prosecdef AND strpos(p.prosrc, 'IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN') > 0) = 3
  UNION ALL SELECT 9, 'as 3 RPCs: anon e PUBLIC fechados, authenticated aberto',
         NOT EXISTS (SELECT 1 FROM rpc WHERE to_regprocedure(rpc.sig) IS NULL
                        OR has_function_privilege('anon', rpc.sig, 'EXECUTE') OR has_function_privilege('public', rpc.sig, 'EXECUTE')
                        OR NOT has_function_privilege('authenticated', rpc.sig, 'EXECUTE'))
  UNION ALL SELECT 10, 'as 10 funções privadas existem e estão fechadas ao JWT',
         NOT EXISTS (SELECT 1 FROM priv WHERE to_regprocedure(priv.sig) IS NULL
                        OR has_function_privilege('anon', priv.sig, 'EXECUTE') OR has_function_privilege('authenticated', priv.sig, 'EXECUTE')
                        OR has_function_privilege('public', priv.sig, 'EXECUTE'))
  UNION ALL SELECT 11, 'os factuais seguem com os corpos de antes (linhas, recompra, situação, lista)',
         NOT EXISTS (SELECT 1 FROM fato LEFT JOIN pg_proc p ON p.oid = to_regprocedure(fato.sig)
                      WHERE md5(p.prosrc) IS DISTINCT FROM fato.m)
  UNION ALL SELECT 12, 'cron venda-sucessao-reprocesso ativo, 1/min, SQL direto',
         EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'venda-sucessao-reprocesso' AND j.active AND j.schedule = '* * * * *'
                    AND j.command = 'SELECT private.venda_sugestoes_drenar_reprocesso();')
)
SELECT n, CASE WHEN ok THEN '✅' ELSE '❌' END AS status, nome FROM c ORDER BY n;
