-- M-17 (plano 2026-09-05, Lote D): retenção de 90 dias em health_score_history e priority_score_log
--
-- Medido via psql-ro (2026-10-11): health_score_history 357 MB / 1,46M linhas, priority_score_log
-- 307 MB / 1,44M linhas, ambas desde 2026-03-02 e sem expurgo (+~800k linhas/mês somadas). ~417k e
-- ~411k linhas já passam de 90 dias. 0 nulos em calculated_at/score_date.
-- São LOG-ONLY: o único writer é a edge calculate-scores (insert); nenhum leitor em src/,
-- supabase/functions/, função SQL ou view (grep + pg_proc/pg_class). Por isso 90 dias não tira dado
-- de tela nenhuma — é o horizonte de auditoria do score.
--
-- O que muda:
--   1. índices por DATA (calculated_at / score_date) — os existentes são (customer|farmer, data DESC) e
--      não servem ao corte global; sem eles o expurgo varre 1,4M linhas por lote.
--   2. private.expurgar_scores_antigos(p_dias, p_lote): apaga em lotes, devolve as contagens, recusa
--      retenção < 30 dias (piso contra chamada errada). Fora da Data API (schema private) + REVOKE nas
--      duas pontas (PUBLIC e anon) e de authenticated.
--   3. cron mensal 'expurgo-scores-farmer' (dia 1, 04:30 UTC — depois do purge-cron-job-run-details das
--      04:00). SQL puro, sem net.http_post (nada de timeout HTTP). O 1º expurgo grande roda no cron de
--      1º/11, não aqui: ~830k deletes na colagem do SQL Editor arriscariam o timeout da tela.
--      Espaço: o DELETE libera para REUSO (autovacuum); o arquivo não encolhe sem VACUUM FULL — e não
--      precisa, a tabela para de crescer.
--
-- Aplicar: SQL Editor do Lovable (o arquivo traz a transação). Idempotente: IF NOT EXISTS, CREATE OR
-- REPLACE e cron.schedule por nome (re-agendar o mesmo nome atualiza o job). CREATE INDEX não-CONCURRENTLY
-- (dentro de transação): bloqueia INSERT da calculate-scores por alguns segundos.
-- Reversão: SELECT cron.unschedule('expurgo-scores-farmer'); DROP FUNCTION private.expurgar_scores_antigos(int, int);
-- Prova: db/test-retencao-scores-farmer.sh (PG17, corte exato na borda + piso + falsificação).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_health_history_calculated_at ON public.health_score_history (calculated_at);
CREATE INDEX IF NOT EXISTS idx_priority_log_score_date      ON public.priority_score_log (score_date);

CREATE OR REPLACE FUNCTION private.expurgar_scores_antigos(p_dias int DEFAULT 90, p_lote int DEFAULT 50000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_corte timestamptz;
  v_h bigint := 0;
  v_p bigint := 0;
  n bigint;
BEGIN
  IF p_dias IS NULL OR p_dias < 30 THEN
    RAISE EXCEPTION 'retencao_minima: p_dias=% < 30', p_dias USING ERRCODE = '22023';
  END IF;
  IF p_lote IS NULL OR p_lote < 1 THEN
    RAISE EXCEPTION 'lote_invalido: p_lote=%', p_lote USING ERRCODE = '22023';
  END IF;
  v_corte := now() - make_interval(days => p_dias);

  LOOP
    DELETE FROM public.health_score_history
     WHERE id IN (SELECT id FROM public.health_score_history WHERE calculated_at < v_corte LIMIT p_lote);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_h := v_h + n;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM public.priority_score_log
     WHERE id IN (SELECT id FROM public.priority_score_log WHERE score_date < v_corte::date LIMIT p_lote);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_p := v_p + n;
    EXIT WHEN n = 0;
  END LOOP;

  RETURN jsonb_build_object('corte', v_corte, 'health_score_history', v_h, 'priority_score_log', v_p);
END;
$function$;

REVOKE ALL ON FUNCTION private.expurgar_scores_antigos(int, int) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('expurgo-scores-farmer', '30 4 1 * *', $cron$SELECT private.expurgar_scores_antigos(90);$cron$);

-- Pós-condição: 2 índices por data, função fechada para anon/authenticated, 1 job com o comando certo.
DO $post$
DECLARE v_idx int; v_job int;
BEGIN
  SELECT count(*) INTO v_idx FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname IN ('idx_health_history_calculated_at', 'idx_priority_log_score_date');
  SELECT count(*) INTO v_job FROM cron.job
   WHERE jobname = 'expurgo-scores-farmer' AND schedule = '30 4 1 * *'
     AND command LIKE '%private.expurgar_scores_antigos(90)%' AND active;
  IF v_idx <> 2 OR v_job <> 1
     OR has_function_privilege('anon', 'private.expurgar_scores_antigos(int, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.expurgar_scores_antigos(int, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M17_POS_FALHOU idx=% job=%', v_idx, v_job;
  END IF;
END
$post$;

COMMIT;
