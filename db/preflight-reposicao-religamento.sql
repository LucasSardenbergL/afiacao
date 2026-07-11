-- db/preflight-reposicao-religamento.sql — READ-ONLY, rodar via psql-ro.
-- PR-2 (money-path): congelar o estado real da prod ANTES de religar as 4 views.
-- P1: as 4 views leem v_venda_items_history_efetivo hoje? (o FROM a trocar)
SELECT 'P1_'||c.relname AS chk,
       (SELECT count(*) FROM regexp_matches(pg_get_viewdef(c.oid,true),'v_venda_items_history_efetivo','g'))::text AS from_hits,
       c.reloptions::text AS reloptions   -- esperado: {security_invoker=true}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
ORDER BY c.relname;

-- P2: a def prod das 4 bate com db/reposicao-consolidacao-demanda.sql? (md5 p/ detectar drift)
SELECT 'P2_'||c.relname AS chk, md5(pg_get_viewdef(c.oid,true)) AS md5_prod
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
ORDER BY c.relname;

-- P3: v_sku_demanda_efetiva existe (PR-1 aplicado)?
SELECT 'P3_demanda_efetiva' AS chk, count(*)::text FROM pg_views WHERE viewname='v_sku_demanda_efetiva';  -- esperado 1

-- P4: v_sku_parametros_sugeridos lê as 4 (herança) — confirmar que NÃO referencia v_sku_demanda_efetiva ainda
SELECT 'P4_sugeridos_ja_le_efetiva' AS chk,
       (SELECT count(*) FROM regexp_matches(pg_get_viewdef('v_sku_parametros_sugeridos',true),'v_sku_demanda_efetiva','g'))::text;  -- esperado 0
