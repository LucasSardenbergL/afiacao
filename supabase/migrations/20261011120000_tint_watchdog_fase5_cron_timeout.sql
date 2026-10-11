-- ============================================================================================
-- 20261011120000 · cron do tint_watchdog_fase5 com teto de tempo PRÓPRIO (10 min)
--
-- O QUE: o job `tint-watchdog-fase5-6h` passa a rodar `SET statement_timeout = '10min'` antes da
-- varredura. Nada mais muda: mesmo nome, mesmo horário (0 */6 * * *), mesma função.
--
-- POR QUÊ (medido em prod, 2026-10-11): a varredura leva 59–106 s e o job morria em 120 s cravados
-- — 2 falhas em 24 rodadas (07/10 12h, 11/10 06h), `canceling statement due to statement timeout`.
-- A rodada que cai não avalia nada: o alerta fica congelado no estado anterior (foi assim que o
-- crítico do S2 sobreviveu à v2 em 11/10). A v1 (20260730120000) supunha que o cron rodava como
-- `supabase_admin` (statement_timeout=0); em prod o job roda como `postgres`, que herda o teto de
-- 2 min do servidor. Por isso o teto vai NO COMANDO, e não na role (mexer na role do `postgres`
-- mudaria tudo o que roda como ele).
--
-- POR QUE NO COMANDO E NÃO `ALTER FUNCTION … SET statement_timeout`: o cronômetro do statement já
-- está correndo quando a função entra — o SET de função só valeria para os statements de DENTRO.
-- Num comando com vários statements (simple query, como o pg_cron envia), o PG ≥13 aplica o teto
-- a CADA statement com o valor vigente: o SET vale para o SELECT seguinte. Provado no PG17.10 local
-- (prod: 17.6) com teto de role 1 s e pg_sleep(2): sem o SET → "canceling statement due to
-- statement timeout"; com o SET no mesmo comando → passa. O pg_cron abre conexão nova por
-- execução, então o SET não vaza para outro job.
--
-- 10 min: ~6x a pior rodada medida, e longe da cadência de 6 h. A anti-sobreposição (advisory
-- lock da função) continua valendo.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- ============================================================================================
SELECT cron.schedule(
  'tint-watchdog-fase5-6h',
  '0 */6 * * *',
  $cron$SET statement_timeout = '10min'; SELECT public.tint_watchdog_fase5_check();$cron$
);

DO $post$
DECLARE
  v_n       integer;
  v_cmd     text;
  v_sched   text;
  v_ativo   boolean;
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
  IF v_sched <> '0 */6 * * *' THEN
    RAISE EXCEPTION 'P3 FALHOU: horário do job mudou: %', v_sched;
  END IF;
  IF NOT v_ativo THEN
    RAISE EXCEPTION 'P4 FALHOU: job inativo — o watchdog pararia de rodar';
  END IF;
  IF to_regprocedure('public.tint_watchdog_fase5_check()') IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: a função chamada pelo job não existe';
  END IF;
  RAISE NOTICE 'tint-watchdog-fase5-6h: 1 job ativo, 0 */6 * * *, teto de 10 min no comando';
END
$post$;
