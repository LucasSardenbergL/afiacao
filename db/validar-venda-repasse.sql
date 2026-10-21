-- Validação pós-apply da 20261020233000_venda_cliente_repasse.sql + 20261021021500_venda_repasse_base_desempenho.sql (read-only).
--   ~/.config/afiacao/psql-ro -X -tA -v ON_ERROR_STOP=1 -f db/validar-venda-repasse.sql
-- Esperado: uma linha começando com ✅. Antes do apply: ❌ (nunca erro — a existência é checada primeiro).
SELECT CASE
  WHEN to_regprocedure('private._defasagem_item(boolean,boolean,date,numeric,numeric,numeric,numeric,timestamptz,numeric,numeric)') IS NULL
    OR to_regprocedure('private._venda_repasse_base(uuid)') IS NULL
    OR to_regprocedure('private._venda_repasse_sku_ok(bigint)') IS NULL
    OR to_regprocedure('public.venda_repasse_candidatos()') IS NULL
    OR to_regprocedure('public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)') IS NULL
    OR to_regprocedure('public.venda_revogar_repasse(uuid)') IS NULL
    OR to_regprocedure('public.venda_preco_alvo_comprador(uuid)') IS NULL
    OR to_regclass('public.venda_repasse_aprovado') IS NULL
    OR to_regclass('public.venda_repasse_aprovado_vigente_uq') IS NULL
    THEN '❌ FALTANDO — migration 20261020233000 não aplicada'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)'))
       IS DISTINCT FROM '5b5c8206fcb4650f1180be3fb13eeeaf'
    THEN '❌ get_defasagem_cliente não é o corpo desta migration'
  WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private._venda_repasse_base(uuid)'))
       IS DISTINCT FROM 'ef2a2e6ab2d35cfe8dd15e0f2cc5686e'
    THEN '❌ _venda_repasse_base ainda é o corpo com autojunção (20261021021500 não aplicada)'
  WHEN NOT has_function_privilege('authenticated', 'public.get_defasagem_cliente(jsonb,uuid)', 'EXECUTE')
    THEN '❌ get_defasagem_cliente perdeu o EXECUTE de authenticated'
  WHEN has_function_privilege('anon', 'public.venda_repasse_candidatos()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.venda_revogar_repasse(uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.venda_preco_alvo_comprador(uuid)', 'EXECUTE')
    THEN '❌ RPC de repasse aberta para anon'
  WHEN has_function_privilege('authenticated', 'private._defasagem_item(boolean,boolean,date,numeric,numeric,numeric,numeric,timestamptz,numeric,numeric)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private._venda_repasse_base(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private._venda_repasse_sku_ok(bigint)', 'EXECUTE')
    THEN '❌ helper privado aberto para authenticated'
  WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.venda_repasse_aprovado'))
    OR has_table_privilege('authenticated', to_regclass('public.venda_repasse_aprovado'), 'SELECT')
    THEN '❌ venda_repasse_aprovado sem RLS ou legível direto'
  ELSE '✅ venda_repasse aplicada: núcleo extraído (md5 5b5c8206…), lote sem autojunção (ef2a2e6a…), 4 RPCs fechadas a anon, tabela com RLS'
END;
