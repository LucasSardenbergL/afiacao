-- Validação PÓS-APPLY da 20261016140000_tint_tombstone_exige_geracao_1.sql (read-only).
-- 2ª testemunha: roda por psql-ro, OUTRA conexão, depois do commit — a pós-condição
-- da migration está dentro do que se quer verificar.
SELECT
  -- mesmo trecho CONTÍGUO da pós-condição: agrupamento + correlação + conta + literal
  CASE WHEN position('g2.desativada_em IS NULL OR g2.desativada_motivo = ''fase5_geracao_legada''::text AND (EXISTS ( SELECT 1 FROM tint_subcolecoes s3 WHERE s3.id = g2.subcolecao_id AND s3.account = g2.account AND s3.id_subcolecao_sayersystem = ''1''::text))' IN d) > 0
       THEN '✅ o carimbo exige geração ''1'' da mesma conta'
       ELSE '❌ endurecimento AUSENTE da view' END AS c1_predicado,
  CASE WHEN (SELECT reloptions @> ARRAY['security_invoker=on'] FROM pg_class
              WHERE oid = 'public.v_tint_formula_canonica'::regclass)
       THEN '✅ security_invoker=on' ELSE '❌ PERDEU security_invoker (#1375)' END AS c2_rls,
  CASE WHEN (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = 'public.v_tint_formula_canonica'::regclass AND attnum > 0 AND NOT attisdropped)
            = 'id,account,sku_id,cor_id,nome_cor,preco_final_sayersystem,subcolecao_id,personalizada,updated_at,is_sl,tem_receita,receita_valida,preco_csv_legado,preco_piso_legado'
       THEN '✅ 14 colunas na ordem' ELSE '❌ shape mudou' END AS c3_shape,
  CASE WHEN (SELECT count(*) FROM public.tint_formulas f
              WHERE f.desativada_motivo = 'fase5_geracao_legada'
                AND NOT EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id = f.subcolecao_id
                                  AND s.account = f.account AND s.id_subcolecao_sayersystem = '1')) = 0
       THEN '✅ delta 0: nenhum carimbo fora da geração ''1'''
       ELSE '⚠️ há carimbo fora da geração ''1'' — o rótulo dessas chaves MUDOU' END AS e1_delta
FROM (SELECT regexp_replace(replace(pg_get_viewdef('public.v_tint_formula_canonica'::regclass, true), 'public.', ''), '\s+', ' ', 'g') AS d) v;
