-- =============================================================================
-- Radar: a passada do score em fatias ganha a madrugada (BRT) — a janela da manhã não fecha um lote novo
-- =============================================================================
-- Medido em prod em 2026-11-20 00:13 UTC, logo depois da 20261120140000 (db/2026-11-20-radar-score-tick-manual.sql,
-- recibo db:aplicar #1207): UMA chamada real no Mini levou 40,9 s, percorreu 8.630 das 93.511 páginas e
-- regravou 6.287 linhas (0 pulados) — ~5–6 ms por linha regravada, o dobro dos 2,9 ms estimados a partir do
-- aplicar_situacao. Faltam ~508 mil linhas do lote 2026-11 ≈ 45–50 min de escrita ≈ 75 chamadas. A janela da
-- 20261120140000 (06:30–08:55 UTC, 30 chamadas/dia) fecharia a passada em ~3 dias, com o lote "pendente" na tela.
--
-- Janela nova do radar-score-recalcular-continua: de 5 em 5 min das 01:00 às 05:55 e das 07:00 às 10:55 UTC
-- (22:00–02:55 e 04:00–07:55 BRT): fora do horário de uso e fora do pipeline das 06:05–06:30 (aplicar-situação,
-- recruzar; o diário 06:30–06:55 fica como está). ~114 chamadas/dia: um lote novo fecha numa madrugada. Sem passada
-- pendente cada tick é o gate (~0,5 s, pelos índices, sem registro: throttle de 20 h). Durante a publicação em
-- passos (radar-publicar-lote, 0-5,7-23 h) o score adia sozinho (radar_lote_publicando()).
-- O aviso único do lote (radar-avisar-lote-diario) vai de 09:05 para 11:05 UTC (08:05 BRT), depois da janela.
--
-- Só cron (nenhuma função muda). Arquivo para `bun run db:aplicar` (sem BEGIN/COMMIT). Prova PG17:
-- db/test-radar-score-fatias.sh (C2). docs/historico/radar-score-timeout-fatias.md
-- ============================================================

DO $job$
DECLARE
  c_cmd CONSTANT text := 'SET statement_timeout = ''3min''; SELECT public.radar_score_recalcular();';
  v_id  bigint;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()'))
     IS DISTINCT FROM '8a0f2beb39821287844f222bd394a8fc' THEN
    RAISE EXCEPTION 'TRAVA: radar_score_recalcular vivo não é o da 20261120140000 — aplique-a antes';
  END IF;

  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'radar-score-recalcular-continua';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'TRAVA: cron radar-score-recalcular-continua ausente — a 20261120140000 não está aplicada';
  END IF;
  PERFORM cron.alter_job(job_id := v_id, schedule := '*/5 1-5,7-10 * * *', command := c_cmd);

  v_id := NULL;
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'radar-avisar-lote-diario';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'TRAVA: cron radar-avisar-lote-diario ausente';
  END IF;
  PERFORM cron.alter_job(job_id := v_id, schedule := '5 11 * * *');
END
$job$;

-- PÓS
DO $post$
DECLARE
  c_cmd CONSTANT text := 'SET statement_timeout = ''3min''; SELECT public.radar_score_recalcular();';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-score-recalcular-continua' AND active AND username = 'postgres'
                    AND schedule = '*/5 1-5,7-10 * * *' AND command = c_cmd) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar-score-recalcular-continua fora da janela nova, inativo ou divergente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-score-recalcular-diario' AND active AND username = 'postgres'
                    AND schedule = '30,35,40,45,50,55 6 * * *' AND command = c_cmd) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar-score-recalcular-diario mudou';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-avisar-lote-diario' AND schedule = '5 11 * * *') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar-avisar-lote-diario não está depois da janela do score (5 11 * * *)';
  END IF;
END
$post$;
