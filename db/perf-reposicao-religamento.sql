-- db/perf-reposicao-religamento.sql — PR-2, prova de PERFORMANCE (furo #14).
-- READ-ONLY. Medido em PROD (PG 17.6) via ~/.config/afiacao/psql-ro em 2026-07-11.
-- ============================================================================
-- VEREDITO: ✅ SEGUE PARA APPLY (sem materializar). O pior consumidor do fan-out
-- (v_sku_parametros_sugeridos) fica ~3.1s pós-religamento — abaixo do alvo 4s e
-- MUITO abaixo do statement_timeout=8s do role authenticated (PostgREST).
-- ============================================================================
--
-- ⚠️ CAVEAT DE MÉTODO (honesto): `SET ROLE authenticated` é NEGADO ao claude_ro
--    ("permission denied to set role"), então NÃO medi sob authenticated. Medi o
--    custo ESTRUTURAL (o fan-out — o que o furo #14 teme) com claude_ro (BYPASSRLS).
--    Isso é REPRESENTATIVO porque a RLS da folha venda_items_history é InitPlan-wrapped:
--      staff_venda_items_history_select USING
--        ( SELECT (has_role((SELECT auth.uid()),'master') OR has_role((SELECT auth.uid()),'employee')) )
--    → avaliada 1× por scan (InitPlan), custo desprezível vs. o fan-out. A camada RLS
--    NÃO é o gargalo aqui (≠ casos SECDEF-por-linha do database.md §4). Ainda assim, o
--    GOLD STANDARD é medir pós-apply real sob authenticated no SQL Editor (bloco no fim).
--
-- ⚠️ O religamento NÃO está aplicado em prod (apply é do founder). As 4 views ainda leem
--    v_venda_items_history_efetivo. Por isso o custo PÓS-religamento das views base foi
--    medido com a def real + FROM trocado inline (pg_get_viewdef | sed), e o dos
--    CONSUMIDORES (sugeridos/candidatos) foi DERIVADO do plano (as views base são
--    computadas 1× dentro deles — Subquery Scan, não re-scan por referência textual).

-- ── MEDIÇÕES (claude_ro, PG 17.6, empresa='OBEN', EXPLAIN ANALYZE BUFFERS) ──
--
-- FONTE (o que o religamento troca):
--   v_venda_items_history_efetivo  (atual) ......  7.6 ms
--   v_sku_demanda_efetiva          (nova)  .... 256.8 ms   (~34× a atual, mas 0.26s absoluto)
--   → overhead por scan da folha = ~249 ms
--
-- VIEWS BASE — atual vs RELIGADA (def real, FROM→v_sku_demanda_efetiva, standalone):
--   v_sku_demanda_estatisticas ....  11.8 ms → 264.4 ms   (+252 ms)
--   v_sku_sigma_demanda ...........  297.4 ms → 553.2 ms  (+256 ms)
--   v_sku_demanda_rajada (2 scans) . 241.7 ms → 809.2 ms  (+567 ms ≈ 2×)
--   → TODAS < 1s religadas (folga 5-15× vs 4s).
--
-- CONSUMIDORES do fan-out (ATUAL / pré-religamento):
--   v_sku_parametros_sugeridos ....... 2073.8 ms   (lê estatisticas+sigma+rajada, 1× cada via Subquery Scan)
--   v_sku_candidatos_primeira_compra .. 759.4 ms   (lê sugeridos filtrado + CTE recorrencia_180d)
--
-- ── ESTIMATIVA PÓS-RELIGAMENTO (2 métodos convergentes) ──
--   sugeridos: v_venda_items_history_efetivo é escaneada 4× na cadeia (est 1 + sigma 1 + rajada 2).
--     • por-view (aditivo, 1× cada): 2073 + 252 + 256 + 567 ≈ 3148 ms
--     • por-scan-da-folha:           2073 + 4 × 249         ≈ 3069 ms
--     → ~3.1s. Sob authenticated: + InitPlans de RLS (desprezível). << 8s timeout.
--   candidatos: 759 ms atual + 1 scan religado da recorrencia_180d (~+249 ms) ≈ ~1.0-1.5s (predicate pushdown reduz).
--
-- CONCLUSÃO: custo estrutural estimado ~3.1s (pior consumidor), folga ~2.6× vs o timeout 8s.
-- ⚠️ NÃO é um p95 sob authenticated+concorrência (Codex P2.2): os 2 métodos acima partem do
-- MESMO incremento por scan (~249 ms) — corroboram, não são independentes; cache frio ou
-- consultas concorrentes do cockpit podem elevar a cauda. O custo estrutural NÃO pede
-- materialização, mas a CONFIRMAÇÃO p95 real é o bloco gold-standard abaixo (founder,
-- pós-apply). Se lá estourar 4s, materializar (grão empresa×sku×data×NF) vira PR-3.
-- Sinalizado, não silenciado.

-- ── GOLD STANDARD (opcional): medir pós-apply REAL sob authenticated, no SQL Editor do
--    Lovable, DEPOIS de aplicar o religamento (o SQL Editor tem permissão de SET ROLE):
BEGIN;
SET LOCAL statement_timeout = '8s';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object(
  'sub', (SELECT user_id::text FROM public.user_roles WHERE role IN ('employee','master') LIMIT 1),
  'role','authenticated')::text, true);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_sku_parametros_sugeridos WHERE empresa='OBEN';
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_sku_candidatos_primeira_compra WHERE empresa='OBEN';
RESET ROLE;
ROLLBACK;   -- read-only: nada é gravado
-- Esperado: Execution Time < 4s em ambas, sem 'canceling statement due to statement timeout'.
