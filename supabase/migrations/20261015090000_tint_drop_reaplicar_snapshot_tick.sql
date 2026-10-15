-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — derruba public.tint_reaplicar_snapshot_tick(), a função ÓRFÃ do #3054
--
-- O #3054 (20261013180000) criou a função e o cron `tint-reaplicar-snapshot-6h` como mitigação
-- das fórmulas-fantasma. A mitigação era NO-OP por construção: o `tint_apply_keys_snapshot`
-- retorna `{"ok": true, "skipped": "snapshot fora de ordem"}` quando `generated_at <=
-- tint_integration_settings.last_keys_snapshot_at`, e cada apply bem-sucedido grava esse campo —
-- então re-aplicar o MESMO snapshot nunca desativa nada. O 20261013200000 desagendou o cron e
-- deixou a função de propósito ("dropá-la seria outra decisão"). Esta é essa decisão.
--
-- POR QUE DERRUBAR, e não deixar inerte: ninguém a chama, e ela é SECURITY DEFINER que escreve em
-- `tint_keys_snapshots`. Uma chamada manual futura repetiria o efeito colateral medido em 13/10 —
-- remarcar o snapshot como `pendente` faz o watchdog da fila acusar "fila de promoção atrasada"
-- (alerta falso) — sem desativar fantasma nenhum. O conserto real (#3051 + 20261013220000) está em
-- prod e segurou: o alerta `tint_fase5_fonte_fantasma` fechou em 14/10 12:00 e não reabriu em 4
-- rodadas do watchdog, atravessando 61 promotes de 10:11 a 20:16 UTC.
--
-- O arquivo 20261013180000 FICA no repo (é histórico aplicado — DR re-roda ele e depois este).
--
-- PRÉ: ABORTA se algum job do pg_cron ainda chama a função — derrubar função que um cron chama
-- troca um no-op por um job falhando a cada execução.
-- PÓS: a função não existe. Idempotente: sem a função, `DROP ... IF EXISTS` é NOTICE e segue.
--
-- APLICAR: DDL destrutivo (`DROP`) é do founder, no SQL Editor (`docs/agent/database.md` §1).
-- Sem BEGIN/COMMIT: o SQL Editor fornece a transação implícita por statement; os dois `DO` abortam
-- antes/depois do DROP.
-- ═════════════════════════════════════════════════════════════════════════════

DO $pre$
DECLARE
  v_jobs text;
BEGIN
  SELECT string_agg(jobname, ', ') INTO v_jobs
    FROM cron.job
   WHERE command ILIKE '%tint_reaplicar_snapshot_tick%';
  IF v_jobs IS NOT NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: job(s) do pg_cron ainda chamam tint_reaplicar_snapshot_tick(): % — desagende antes (20261013200000)', v_jobs;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.tint_reaplicar_snapshot_tick();

DO $post$
BEGIN
  IF to_regprocedure('public.tint_reaplicar_snapshot_tick()') IS NOT NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: public.tint_reaplicar_snapshot_tick() ainda existe';
  END IF;
  RAISE NOTICE 'tint_reaplicar_snapshot_tick() removida — nenhum job do pg_cron a referenciava';
END
$post$;
