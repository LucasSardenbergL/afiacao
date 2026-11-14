-- Validação pós-apply da 20261113213000_venda_repasse_demanda_viva.sql (read-only).
--   ~/.config/afiacao/psql-ro -q -tA -v ON_ERROR_STOP=1 -f db/validar-venda-repasse-vivo.sql
-- Esperado: uma linha começando com ✅ e a linha FIM. Antes do apply: ❌ (nunca erro — a existência vem primeiro).
SELECT CASE
  WHEN to_regprocedure('public.venda_repasse_sensor()') IS NULL
    THEN '❌ FALTANDO — venda_repasse_sensor ausente (20261113213000 não aplicada)'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_repasse_candidatos()'))
       IS DISTINCT FROM '3679078c645ae6090153678ab1300961'
    THEN '❌ venda_repasse_candidatos não é o corpo da 20261113213000'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)'))
       IS DISTINCT FROM '4f9b0f18f2ed6d5d44d5c5d792f4c94d'
    THEN '❌ venda_aprovar_repasse não é o corpo da 20261113213000'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_repasse_sensor()'))
       IS DISTINCT FROM 'c82b33288c3879dc6a1b63813dab78c3'
    THEN '❌ venda_repasse_sensor não é o corpo da 20261113213000'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])'))
       IS DISTINCT FROM '880fde236d6a1fce766018c38e42ddee'
    THEN '❌ a regra única private._venda_repasse_situacao mudou'
  WHEN has_function_privilege('anon', 'public.venda_repasse_sensor()', 'EXECUTE')
    OR has_function_privilege('public', 'public.venda_repasse_sensor()', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.venda_repasse_sensor()', 'EXECUTE')
    THEN '❌ ACL do sensor errada (anon/PUBLIC abertos ou authenticated fechado)'
  WHEN has_function_privilege('anon', 'public.venda_repasse_candidatos()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)', 'EXECUTE')
    THEN '❌ candidatos/aprovar abertos a anon'
  WHEN (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'venda_repasse_aprovado'
           AND ((column_name IN ('cadencia_na_aprovacao', 'qtd_ref_na_aprovacao', 'custo_na_aprovacao')
                 AND data_type = 'numeric' AND numeric_precision IS NULL)
                OR (column_name = 'ultima_compra_na_aprovacao' AND data_type = 'date'))
           AND is_nullable = 'YES' AND column_default IS NULL) <> 4
    THEN '❌ linha de base do sensor incompleta em venda_repasse_aprovado'
  ELSE '✅ 20261113213000 aplicada: candidatos/aprovar/sensor = corpos da migration, regra única intacta, ACL e 4 colunas ok'
END AS status;
SELECT 'FIM';
