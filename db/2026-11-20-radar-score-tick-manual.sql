-- Disparo manual de UMA rodada do score do Radar em fatias (20261120140000), logo depois do apply, para medir
-- a chamada real no Mini antes do cron das 06:30 UTC. Idempotente (a passada converge; outra chamada só continua
-- o cursor), transacional pelo executor (`bun run db:aplicar`), com pós-condição: a rodada rodou (não foi
-- adiada), ficou abaixo de 100 s e deixou o registro no ledger.
-- docs/historico/radar-score-timeout-fatias.md
DO $tick$
DECLARE
  v_ini timestamptz := clock_timestamp();
  r     jsonb;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()'))
     IS DISTINCT FROM '8a0f2beb39821287844f222bd394a8fc' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_score_recalcular vivo não é o da 20261120140000';
  END IF;
  r := public.radar_score_recalcular();
  IF r ? 'adiado' THEN
    RAISE EXCEPTION 'TICK adiado (%): nada a medir agora', r->>'adiado';
  END IF;
  IF clock_timestamp() - v_ini > interval '100 seconds' THEN
    RAISE EXCEPTION 'TICK FALHOU: % — acima do orçamento', clock_timestamp() - v_ini;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.acoes_execucoes
                  WHERE acao IN ('radar.score_recalcular', 'radar.score_recalcular_parcial')
                    AND iniciado_em >= v_ini) THEN
    RAISE EXCEPTION 'TICK FALHOU: rodada sem registro no ledger';
  END IF;
  RAISE NOTICE 'tick: %', r;
END
$tick$;
