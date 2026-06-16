-- ============================================================
-- Popular + agendar refresh das matviews de análise dimensional
-- ============================================================
-- fin_analise_cr/cp_dimensoes foram criadas WITH NO DATA (28/mar) e NUNCA foram
-- refreshadas (não havia cron chamando fin_refresh_analise_dimensoes()) → 0 linhas.
-- Sem isto, /financeiro/analytics continua vazia mesmo com as RPCs gated.
--
-- A função fin_refresh_analise_dimensoes() já existe (REFRESH CONCURRENTLY com
-- fallback não-concurrent). As matviews têm índice UNIQUE → CONCURRENTLY funciona
-- após o 1º populate. O 1º populate precisa ser NÃO-concurrent (matview WITH NO DATA).
-- ============================================================

-- 1) Populate inicial (não-concurrent; pode levar alguns segundos)
REFRESH MATERIALIZED VIEW public.fin_analise_cr_dimensoes;
REFRESH MATERIALIZED VIEW public.fin_analise_cp_dimensoes;

-- 2) Cron de refresh (upsert por nome → idempotente). Roda como postgres (dono das
--    matviews) → pode refreshar. Alinhado após as syncs do Omie (8h/14h); ajuste à vontade.
SELECT cron.schedule(
  'fin-refresh-analise-dimensoes',
  '0 10,16 * * *',
  $$SELECT public.fin_refresh_analise_dimensoes()$$
);
