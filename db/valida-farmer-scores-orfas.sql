-- Validação PÓS-APPLY de 20260727130000_farmer_scores_colunas_orfas_null.sql
-- Roda de QUALQUER role (psql-ro OU SQL Editor): LÊ CATÁLOGO/dados, NUNCA invoca função (lição
-- #1462 — validação que chama objeto mente nos dois sentidos). Cole no SQL Editor após o Run, ou
-- eu rodo via psql-ro.

\echo '=== (1) DEFAULT removido das 6 colunas (column_default deve ser vazio) ==='
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_name = 'farmer_client_scores'
  AND column_name IN ('recover_score','expansion_score','revenue_potential','x_score','s_score','eff_score')
ORDER BY column_name;
-- ESPERADO: column_default vazio (NULL) nas 6 linhas.

\echo ''
\echo '=== (2) Backfill: as 6 colunas 100% NULL (0 não-nulos cada) ==='
SELECT
  count(*)                                              AS total,
  count(*) FILTER (WHERE recover_score     IS NOT NULL) AS recover_nn,
  count(*) FILTER (WHERE expansion_score   IS NOT NULL) AS expansion_nn,
  count(*) FILTER (WHERE revenue_potential IS NOT NULL) AS revenue_nn,
  count(*) FILTER (WHERE x_score           IS NOT NULL) AS x_nn,
  count(*) FILTER (WHERE s_score           IS NOT NULL) AS s_nn,
  count(*) FILTER (WHERE eff_score         IS NOT NULL) AS eff_nn
FROM farmer_client_scores;
-- ESPERADO: *_nn = 0 em todas (o fóssil expansion=60 e o 0 fabricado viraram NULL).

\echo ''
\echo '=== (3) Propagação CIRÚRGICA: só os fósseis (expansion era 60) foram enfileirados ==='
SELECT count(*) FILTER (WHERE reason = 'expansion_orfa_backfill' AND processed_at IS NULL) AS fosseis_enfileirados,
       count(*) FILTER (WHERE processed_at IS NULL)                                        AS total_pendentes
FROM visit_score_recalc_queue;
-- ESPERADO: fosseis_enfileirados ~= 303 (o baseline dos expansion=60), NÃO 6633. A supressão via
-- session_replication_role impede a inundação da fila; só os 303 que mudam de missão entram.
-- Drena em 1 noite (303 < max_drain 500 do visit-score-recalc-batch).

\echo ''
\echo '=== (4) DIFERIDA — rode APÓS o dreno da fila (próximo batch): missão EXPANSÃO fóssil sumiu ==='
SELECT primary_mission, count(*) AS n, round(avg(visit_score), 2) AS media
FROM customer_visit_scores
GROUP BY primary_mission
ORDER BY n DESC;
-- ESPERADO: 'expansao' cai de 169 (todos com visit_score=36,00) para ~0 — nenhum cliente pode
-- receber a missão EXPANSÃO enquanto expansion_score não tiver produtor. Os 169 migram para
-- recuperacao/prospeccao conforme os demais sinais.
