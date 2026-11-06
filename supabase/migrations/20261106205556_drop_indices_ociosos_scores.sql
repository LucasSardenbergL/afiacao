-- Plano v4, lote 11 (B1) / plano v7 D5: DROP dos 4 índices sem uso de health_score_history e priority_score_log
--
-- Medido via psql-ro (2026-11-06 20:55 UTC): 0 scans em 6 d 10 h de contador (desde o restart de
-- 2026-10-31 10:33 UTC; stats_reset nulo), atravessando o escritor diário (calculate-scores), o expurgo
-- de 1º/11 e todos os dias da semana. Nenhuma constraint usa os índices. Leitores instalados em prod:
-- nenhum além do expurgo (docs/historico/retencao-scores-60d.md), e ele vai pelos índices por DATA.
--   idx_health_history_customer   (customer_user_id, calculated_at DESC)  104 MB
--   idx_health_history_farmer     (farmer_id, calculated_at DESC)          25 MB
--   idx_priority_log_customer     (customer_user_id, score_date DESC)      65 MB
--   idx_priority_log_farmer_date  (farmer_id, score_date DESC)             17 MB
-- Ganho: ~211 MB liberados na hora, e cada INSERT da calculate-scores e cada DELETE do expurgo deixam
-- de manter 4 árvores.
--
-- Aplicar: SQL Editor do Lovable (DDL destrutivo é do founder). O arquivo traz a transação. DROP INDEX
-- não-CONCURRENTLY pega AccessExclusiveLock na tabela por um instante (catálogo + unlink); o lock_timeout
-- aborta em vez de enfileirar atrás de alguém. Evite 06:00–06:30 UTC (calculate-scores) e domingo 04:30
-- UTC (expurgo).
-- PRE: aborta se algum dos 4 tiver ganhado scan desde a medição (alguém passou a ler).
-- Idempotente: DROP INDEX IF EXISTS; re-colar é no-op.
-- Reversão (CREATE INDEX de ~1 min cada, sem perda de dado):
--   CREATE INDEX idx_health_history_customer ON public.health_score_history (customer_user_id, calculated_at DESC);
--   CREATE INDEX idx_health_history_farmer ON public.health_score_history (farmer_id, calculated_at DESC);
--   CREATE INDEX idx_priority_log_customer ON public.priority_score_log (customer_user_id, score_date DESC);
--   CREATE INDEX idx_priority_log_farmer_date ON public.priority_score_log (farmer_id, score_date DESC);
-- Prova: db/test-drop-indices-scores.sh (PG17: PRE com scan aborta, DROP, POS, idempotência, falsificação).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE v_lidos text;
BEGIN
  SELECT string_agg(indexrelname || '=' || idx_scan, ', ') INTO v_lidos
    FROM pg_stat_user_indexes
   WHERE schemaname = 'public'
     AND indexrelname IN ('idx_health_history_customer', 'idx_health_history_farmer',
                          'idx_priority_log_customer', 'idx_priority_log_farmer_date')
     AND idx_scan > 0;
  IF v_lidos IS NOT NULL THEN
    RAISE EXCEPTION 'D5_PRE_FALHOU: índice com scan desde a medição (%) — alguém lê; não dropar', v_lidos;
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.idx_health_history_customer;
DROP INDEX IF EXISTS public.idx_health_history_farmer;
DROP INDEX IF EXISTS public.idx_priority_log_customer;
DROP INDEX IF EXISTS public.idx_priority_log_farmer_date;

-- Pós-condição: os 4 sumiram; ficaram válidos as PKs e os índices por data que o expurgo usa.
DO $post$
DECLARE v_restam int; v_ficam int;
BEGIN
  SELECT count(*) INTO v_restam FROM pg_class
   WHERE relkind = 'i' AND relnamespace = 'public'::regnamespace
     AND relname IN ('idx_health_history_customer', 'idx_health_history_farmer',
                     'idx_priority_log_customer', 'idx_priority_log_farmer_date');
  SELECT count(*) INTO v_ficam FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
   WHERE ix.indisvalid AND i.relnamespace = 'public'::regnamespace
     AND i.relname IN ('health_score_history_pkey', 'priority_score_log_pkey',
                       'idx_health_history_calculated_at', 'idx_priority_log_score_date');
  IF v_restam <> 0 OR v_ficam <> 4 THEN
    RAISE EXCEPTION 'D5_POS_FALHOU restam=% ficam=%', v_restam, v_ficam;
  END IF;
END
$post$;

COMMIT;
