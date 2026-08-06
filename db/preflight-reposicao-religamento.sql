-- db/preflight-reposicao-religamento.sql — READ-ONLY, rodar via psql-ro.
-- PR-2 (money-path): congela o estado REAL da prod ANTES do religamento, para a
-- Task 2 partir da def prod EXATA (não do repo — o #1292 tocou estas views com
-- security_invoker; pode haver drift). Ver docs/superpowers/plans/2026-07-11-reposicao-pr2-religamento.md Task 0.

-- P1: as 4 views leem v_venda_items_history_efetivo hoje? (o FROM a trocar) + reloptions (security_invoker).
SELECT 'P1_'||c.relname AS chk,
       (SELECT count(*) FROM regexp_matches(pg_get_viewdef(c.oid,true),'v_venda_items_history_efetivo','g'))::text AS from_hits,
       c.reloptions::text AS reloptions   -- esperado: {security_invoker=true}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
ORDER BY c.relname;

-- P2: md5 da def prod das 4 (p/ detectar drift entre capturas / comparar com o repo).
SELECT 'P2_'||c.relname AS chk, md5(pg_get_viewdef(c.oid,true)) AS md5_prod
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
ORDER BY c.relname;

-- P3: v_sku_demanda_efetiva existe (PR-1 aplicado em prod)? (handoff dizia 0; msg do founder/plano diz aplicado)
SELECT 'P3_demanda_efetiva' AS chk, count(*)::text AS existe FROM pg_views WHERE viewname='v_sku_demanda_efetiva';  -- esperado 1

-- P4: v_sku_parametros_sugeridos lê as 4 (herança) — confirmar que NÃO referencia v_sku_demanda_efetiva ainda (herda pelo religamento das 4).
SELECT 'P4_sugeridos_ja_le_efetiva' AS chk,
       (SELECT count(*) FROM regexp_matches(pg_get_viewdef('v_sku_parametros_sugeridos',true),'v_sku_demanda_efetiva','g'))::text AS hits;  -- esperado 0

-- P5: shape — nº e ordem de colunas de cada view (o CREATE OR REPLACE tem de preservar a ORDEM exata).
SELECT 'P5_'||table_name AS chk, count(*)::text AS n_colunas,
       string_agg(column_name, ',' ORDER BY ordinal_position) AS colunas_em_ordem
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN
  ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
GROUP BY table_name ORDER BY table_name;
