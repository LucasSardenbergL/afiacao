-- Validação pós-apply da 20261020150000_venda_cliente_recompra.sql (read-only).
--   ~/.config/afiacao/psql-ro -X -tA -v ON_ERROR_STOP=1 -f db/validar-venda-recompra.sql
-- Esperado: uma linha começando com ✅. Antes do apply: ❌ (nunca erro — a existência é checada primeiro).
SELECT CASE
  WHEN to_regprocedure('public.venda_recompra_em(date)') IS NULL
    OR to_regprocedure('public.venda_situacao_em(date)') IS NULL
    OR to_regprocedure('public.venda_recompra_atualizar()') IS NULL
    OR to_regprocedure('private.venda_linhas_pedido(date)') IS NULL
    OR to_regprocedure('private.venda_mediana(numeric[])') IS NULL
    OR to_regclass('public.venda_recompra') IS NULL
    OR to_regclass('public.venda_situacao') IS NULL
    THEN '❌ FALTANDO — migration 20261020150000 não aplicada'
  WHEN has_function_privilege('anon', 'public.venda_recompra_em(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_recompra_em(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_situacao_em(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_recompra_atualizar()', 'EXECUTE')
    THEN '❌ ACL aberta para anon/authenticated'
  WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.venda_recompra'))
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.venda_situacao'))
    THEN '❌ RLS desligada num snapshot'
  WHEN NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'venda-recompra' AND schedule = '50 7 * * *' AND active)
    THEN '❌ cron venda-recompra ausente/inativo'
  ELSE (
    SELECT CASE WHEN n_sku > 0 AND n_comp > 0
                THEN format('✅ venda_recompra aplicada: %s SKUs · %s compradores · ref %s', n_sku, n_comp, ref)
                ELSE format('❌ snapshot vazio (SKUs %s · compradores %s)', n_sku, n_comp) END
      FROM (SELECT (xpath('//n/text()', query_to_xml('SELECT count(*) AS n FROM public.venda_recompra', false, true, '')))[1]::text::int AS n_sku,
                   (xpath('//n/text()', query_to_xml('SELECT count(*) AS n FROM public.venda_situacao', false, true, '')))[1]::text::int AS n_comp,
                   (xpath('//n/text()', query_to_xml('SELECT max(data_referencia) AS n FROM public.venda_situacao', false, true, '')))[1]::text AS ref) x)
END AS status;
