-- Validação pós-apply da 20261113213317_venda_sistema_completo (read-only; psql-ro). Esperado: tudo ✅.
SELECT x.item, CASE WHEN x.ok THEN '✅' ELSE '❌' END AS status FROM (VALUES
  ('corpos recriados = este', (SELECT bool_and(md5(p.prosrc) = v.md5) FROM (VALUES
      ('public.venda_gerar_lista(date,text)', 'fa710709f8a598258460f2971d2ec2fe'),
      ('public.venda_fechar_desfechos(date)', '18b1768290af7e0ce66601cc389b37da'),
      ('private._venda_sugestoes_json(uuid,date)', 'd2ead2156bf76b6047a591e156148e64'),
      ('private.venda_resumo_bloco(uuid,date,uuid,integer,text,numeric,text)', '3b2c0dd39af68a0a50e4320cb48f6ebb')) v(f, md5)
      JOIN pg_proc p ON p.oid = to_regprocedure(v.f))),
  ('tabelas com RLS', (SELECT count(*) = 2 FROM pg_class WHERE relrowsecurity
      AND oid IN (to_regclass('public.venda_sistema_par'), to_regclass('public.venda_sistema_par_decisao')))),
  ('venda_sugestao aceita sistema', (SELECT count(*) = 3 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
      AND convalidated AND conname IN ('venda_sugestao_tipo_check','venda_sugestao_alvo_ck','venda_sugestao_sistema_ck')
      AND (conname = 'venda_sugestao_sistema_ck' OR pg_get_constraintdef(oid) LIKE '%sistema%'))),
  ('config completa', (SELECT count(*) = 3 FROM public.venda_config WHERE chave IN ('onda_sistema','sistema_regras','sistema_familias'))
      AND (SELECT jsonb_typeof(valor -> 'sistema') = 'number' FROM public.venda_config WHERE chave = 'janela_dias')),
  ('RPCs fechadas p/ anon e abertas p/ authenticated', (SELECT bool_and(NOT has_function_privilege('anon', f, 'EXECUTE')
      AND has_function_privilege('authenticated', f, 'EXECUTE')) FROM unnest(ARRAY['public.venda_sistema_fila(text)',
      'public.venda_sistema_decidir(bigint,text)','public.venda_sistema_sensor(date,date)']) f)),
  ('helpers fechados p/ authenticated', (SELECT bool_and(NOT has_function_privilege('authenticated', f, 'EXECUTE'))
      FROM unnest(ARRAY['private.venda_sistema_cita(text,text)','private.venda_sistema_candidatos(text,date)',
      'private.venda_sistema_boletim(text,bigint,bigint,text)','private.venda_lista_sistema(date)']) f))
) x(item, ok);
