-- ============================================================================================
-- 20261103222735 · tint_watchdog_fase5 sai do horário de loja (0 */6 → 30 9,21 UTC)
--
-- O QUE: o job `tint-watchdog-fase5-6h` passa a rodar 2x/dia, às 09:30 e 21:30 UTC (06:30 e 18:30
-- de Brasília). Nada mais muda: mesmo nome (a Camada A cita o nome no texto do alerta), mesmo
-- comando byte a byte (teto de 10 min da 20261011120000), mesma função (v5, 20261101050000).
--
-- POR QUÊ (medido em prod, psql-ro, 2026-11-02/03): mesmo com a v5 a 24–42 s, a rodada lê ~1,1 GB
-- do disco e ~365 MB de temp — a janela de 15 min dela reprova o Mini (18:00 UTC de 02/11: 2,18 GB
-- de disco, hit 91%, temp 466 MB; docs/historico/tint-purge-staging-io.md). Com 0 */6, as rodadas
-- das 12:00 e 18:00 UTC caem no meio da loja. Horário de loja medido pelo agente tintométrico
-- (tint_sync_runs, 14 dias, seg–sáb): ~650/h das 10 às 19 UTC, ~470 às 20, ~260/h das 21 às 09 —
-- loja = 10:00–20:59 UTC.
--
-- POR QUE 30 9,21 E NÃO OUTRO: o dead-man da Camada A (tint_watchdog_corante_check) alarma quando o
-- marcador do fase5 passa de 13 h. Com 2 rodadas o maior intervalo tem que ser ≤ 12 h, e as duas
-- precisam ficar fora de 10–21 UTC: o ÚNICO par é 21:xx + 09:xx. Assim o limite de 13 h fica
-- intocado (mudar exigiria recriar a Camada A, money-path). O minuto 30 evita os crons das 09:00,
-- 09:05 e 09:15. A rodada das 09:30 deixa o estado fresco para a abertura da loja.
--
-- CUSTO CONHECIDO (aceito): antes, uma rodada perdida não alarmava (6 h + 6 h < 13 h); agora UMA
-- rodada perdida alarma ~1 h depois (12 h + 1 h). Isso está certo: sem ela a rede fica cega 24 h.
-- A latência de detecção vai de ≤ 6 h para ≤ 12 h.
--
-- ACOPLAMENTO: se alguém baixar o dead-man da Camada A para < 12 h, este horário passa a alarmar
-- sozinho — a P6 abaixo exige o limite de 13 h no corpo VIVO da Camada A. E re-aplicar a v5
-- (20261101050000) volta o job para 0 */6 (a P10 dela exige isso); a última a rodar vence.
--
-- TRANSIÇÃO: o intervalo entre a última rodada do horário VELHO e a 1ª do NOVO também conta para o
-- dead-man. Aplicar entre 21:30 e 00:00 UTC (marcador das 18:00, próxima às 09:30 = 15,5 h) ou
-- entre 09:30 e 12:00 alarmaria. A P7 recusa: exige próxima rodada − marcador ≤ 12 h 30 min.
-- Janelas seguras: 00:00–09:30 e 12:00–21:30 UTC, DEPOIS da rodada do horário cheio.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- ============================================================================================
SELECT cron.schedule(
  'tint-watchdog-fase5-6h',
  '30 9,21 * * *',
  $cron$SET statement_timeout = '10min'; SELECT public.tint_watchdog_fase5_check();$cron$
);

DO $post$
DECLARE
  v_n       integer;
  v_cmd     text;
  v_sched   text;
  v_ativo   boolean;
  v_corante text;
  v_marcador timestamptz;
  v_dia      timestamptz;
  v_proxima  timestamptz;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'tint-watchdog-fase5-6h';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P1 FALHOU: % job(s) tint-watchdog-fase5-6h — esperado exatamente 1', v_n;
  END IF;
  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo
    FROM cron.job WHERE jobname = 'tint-watchdog-fase5-6h';
  IF v_cmd <> $c$SET statement_timeout = '10min'; SELECT public.tint_watchdog_fase5_check();$c$ THEN
    RAISE EXCEPTION 'P2 FALHOU: comando do job inesperado: %', v_cmd;
  END IF;
  IF v_sched <> '30 9,21 * * *' THEN
    RAISE EXCEPTION 'P3 FALHOU: horário do job não é 30 9,21 * * *: %', v_sched;
  END IF;
  IF NOT v_ativo THEN
    RAISE EXCEPTION 'P4 FALHOU: job inativo — o watchdog pararia de rodar';
  END IF;
  IF to_regprocedure('public.tint_watchdog_fase5_check()') IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: a função chamada pelo job não existe';
  END IF;
  -- o intervalo máximo (12 h) só é seguro se o dead-man da Camada A continuar em 13 h
  SELECT p.prosrc INTO v_corante FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.tint_watchdog_corante_check()');
  IF v_corante IS NULL
     OR v_corante !~ 'v_b_atraso\s*>\s*interval\s*''13 hours''' THEN
    RAISE EXCEPTION 'P6 FALHOU: o dead-man da Camada A não está mais em > 13 h — com rodadas a cada 12 h ele alarmaria sozinho';
  END IF;
  -- transição: a 1ª rodada do horário novo não pode cair a mais de 12 h 30 min do último marcador.
  -- Marcador ausente (rebuild/DR) = nada a proteger.
  SELECT max(last_sync_at) INTO v_marcador FROM sync_state WHERE entity_type = 'tint_watchdog_fase5';
  v_dia := date_trunc('day', now(), 'UTC');
  SELECT min(t) INTO v_proxima
    FROM unnest(ARRAY[v_dia + interval '9 hours 30 minutes',
                      v_dia + interval '21 hours 30 minutes',
                      v_dia + interval '1 day 9 hours 30 minutes']) AS t
   WHERE t > now();
  IF v_marcador IS NOT NULL AND v_proxima - v_marcador > interval '12 hours 30 minutes' THEN
    RAISE EXCEPTION 'P7 FALHOU: última rodada em % e a próxima só em % (% depois) — o dead-man de 13 h alarmaria. Aplique entre 00:00–09:30 ou 12:00–21:30 UTC, depois da rodada',
      v_marcador, v_proxima, v_proxima - v_marcador;
  END IF;
  RAISE NOTICE 'tint-watchdog-fase5-6h: 1 job ativo, 30 9,21 * * *, teto de 10 min, dead-man da A em 13 h, próxima rodada %', v_proxima;
END
$post$;
