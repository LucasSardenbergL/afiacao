-- db/perf-reposicao-religamento.sql — prova de performance do religamento (PR-2, furo #14).
-- Rodar via psql-ro. READ-ONLY (EXPLAIN ANALYZE executa SELECTs, não escreve).
--
-- Raciocínio da medição: a VARIÁVEL que o religamento introduz é o ramo de consumo
-- (JOIN v_pcp_malha_oben) que v_sku_demanda_efetiva soma sobre v_venda_items_history_efetivo.
-- Essa variável é ORTOGONAL à RLS: a policy staff_venda_items_history_select (has_role
-- master/employee) poda as MESMAS linhas antes e depois do religamento e é avaliada como
-- InitPlan O(1), não por linha. claude_ro tem BYPASSRLS → vê TODAS as empresas = PIOR caso
-- de volume. Logo: se folga aqui, folga sob authenticated (que vê <= linhas). Veredito
-- exige folga (p95 < 4s) contra o statement_timeout de 8s do PostgREST.

SET statement_timeout='8s';

\echo '=== [1] BASELINE: v_venda_items_history_efetivo (fonte ANTIGA que as 4 views liam) ==='
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM v_venda_items_history_efetivo;

\echo '=== [2] NOVA FONTE: v_sku_demanda_efetiva (venda inverted-caret consumo — a variavel do religamento) ==='
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM v_sku_demanda_efetiva;

\echo '=== [3] VIEW CONSUMIDORA hoje: v_sku_demanda_estatisticas (le historia — baseline de agregacao) ==='
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM v_sku_demanda_estatisticas WHERE empresa='OBEN';

\echo '=== [4] CONSUMIDOR FINAL: v_sku_parametros_sugeridos (o que o motor le por ciclo) ==='
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM v_sku_parametros_sugeridos WHERE empresa='OBEN';

\echo '=== [5] CANDIDATOS: v_sku_candidatos_primeira_compra (a 4a view, tambem religada) ==='
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM v_sku_candidatos_primeira_compra WHERE empresa='OBEN';
