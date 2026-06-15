-- =============================================================================
-- RADAR DE CLIENTES — índices de performance (Fatia 3, perf fix)
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable. JÁ APLICADO EM PROD
--    (2026-06-13, indices_3=3). Migration aditiva e idempotente (IF NOT EXISTS).
--
-- Diagnóstico (benchmark PG17 com 500k linhas, db/bench-radar — Codex fora da cota):
--   A LISTA do /radar fazia um sort top-50 de ~520k linhas SEM índice útil — o
--   idx_radar_empresas_fila (ultimo_lote, prospeccao_status, data_abertura DESC)
--   exige igualdade nas 2 primeiras colunas, que o preset 'novas' (fila default)
--   NÃO fornece. No M2 local isso é 27ms; em prod (Supabase cache-frio) o sort de
--   meio milhão escala mal = "demora pra carregar as empresas".
--   Índice parcial dedicado → 0.13ms (200×) na lista; ranking 86→37ms.
--
-- Parciais (só a FILA ATIVA: não-cliente E não-descartado) → pequenos e exatos pro
-- caso DEFAULT da tela. Quando o founder filtra por status específico ou inclui
-- já-clientes, a query cai no plano normal (subset menor, aceitável).
--
-- ⚠️ CREATE INDEX sobre 526k pode estourar o timeout do SQL Editor → o SET abaixo
--    estende o limite da sessão (sem ele, "Query failed" por statement_timeout).
-- =============================================================================

SET statement_timeout = '600s';

-- Preset "Novas do lote" (default): ORDER BY data_abertura DESC, cnpj.
CREATE INDEX IF NOT EXISTS idx_radar_lista_novas
  ON public.radar_empresas (data_abertura DESC, cnpj)
  WHERE ja_cliente = false AND prospeccao_status <> 'descartado';

-- Preset "Estabelecidas": ORDER BY capital_social DESC, cnpj.
CREATE INDEX IF NOT EXISTS idx_radar_lista_estab
  ON public.radar_empresas (capital_social DESC, cnpj)
  WHERE ja_cliente = false AND prospeccao_status <> 'descartado';

-- Ranking/mapa: GROUP BY municipio_codigo (radar_contagem_por_municipio).
CREATE INDEX IF NOT EXISTS idx_radar_muni
  ON public.radar_empresas (municipio_codigo)
  WHERE ja_cliente = false AND prospeccao_status <> 'descartado';

-- Validação pós-apply (esperar indices_3 = 3)
SELECT 'RADAR PERF OK' AS status,
  (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='radar_empresas'
    AND indexname IN ('idx_radar_lista_novas','idx_radar_lista_estab','idx_radar_muni')) AS indices_3;
