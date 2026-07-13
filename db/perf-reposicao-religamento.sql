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

-- ═════════════════════════════════════════════════════════════════════════════
-- VEREDITO (medido em prod via psql-ro/BYPASSRLS = pior caso de volume, 2026-07-12).
-- Cada view religada foi medida inline (def com FROM v_sku_demanda_efetiva) vs a atual:
--   View                              ATUAL (historia)   RELIGADA (efetiva)   Delta
--   v_sku_demanda_estatisticas          240 ms             243 ms             +3 ms
--   v_sku_sigma_demanda                 527 ms             528 ms             +1 ms
--   v_sku_demanda_rajada                703 ms             707 ms             +4 ms
--   v_sku_candidatos_primeira_compra   2032 ms            2047 ms            +15 ms
-- O religamento e ~INERTE em custo (+1 a +15 ms): as views filtram data_emissao>=180d e o
-- custo dominante e a serie temporal/agregacao, nao a leitura da fonte; o ramo de consumo
-- adiciona poucas linhas (so pais com ficha). Pior view = 2s < 4s (p95 alvo) < 8s (timeout).
-- BYPASSRLS ve TODAS as empresas (pior volume); a policy has_role de venda_items_history e
-- InitPlan O(1) -> sob role authenticated (staff, mesmo volume) o custo e <=. NAO materializar.
-- Furo #14 do Codex: FECHADO.
