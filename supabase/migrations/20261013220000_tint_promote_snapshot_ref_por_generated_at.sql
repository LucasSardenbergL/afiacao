-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — o promote escolhe o snapshot de referência pela ORDEM DO APPLY (generated_at),
-- não por aplicado_em [money-path]
--
-- Ajuste do 20261013150000 (#3051, já em prod — não se edita migration aplicada: o ledger do
-- db:aplicar guarda o sha dela). Achado: challenge Codex da v4 do watchdog (PR #3056), repassado
-- pela sessão da v4.
--
-- O FURO: o #3051 escolhe o "último snapshot aplicado" por max(aplicado_em). Mas o
-- tint_apply_keys_snapshot, quando reaplica um snapshot que NÃO é mais novo que o último aplicado
-- (generated_at <= tint_integration_settings.last_keys_snapshot_at), PULA — {"skipped":"fora de
-- ordem"}, nada desativado — e mesmo assim o tick o marca 'aplicado' e REGRAVA aplicado_em. Então:
--   A (antigo) tem a cor R; B (mais novo, aplicado de fato) retira R; alguém reaplica A, que é
--   pulado mas ganha aplicado_em novo → o promote passa a usar A como referência → R aparece como
--   PRESENTE → o staging antigo de R volta a reativar a fórmula. É o defeito do #3051 de volta.
-- Hoje é LATENTE: o único reapply em prod era o cron tint-reaplicar-snapshot-6h (#3054), que
-- reaplicava o MESMO snapshot e já foi removido (19:28 UTC de 2026-10-13).
--
-- A CORREÇÃO: ORDER BY max(generated_at) DESC — a ordem do PRÓPRIO apply. Um snapshot só é
-- aplicado de fato com generated_at > last_keys_snapshot_at, logo o de maior generated_at entre os
-- 'aplicado' é sempre o último aplicado de verdade; um reapply pulado nunca o ultrapassa. O relógio
-- da COMPARAÇÃO com o staging continua created_at (servidor × servidor) — só a ESCOLHA muda.
--
-- COMO APLICA: corpo vivo + 1 replace ancorado (aborta se a âncora não casar exatamente 1 vez);
-- pré-flight exige o #3051 vivo; marca de idempotência; pós-condição lida do catálogo; REVOKE por
-- cinto (CREATE OR REPLACE via EXECUTE preserva o ACL).
--
-- APLICAR: bun run db:aplicar supabase/migrations/20261013220000_tint_promote_snapshot_ref_por_generated_at.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-promote-fantasma.sh (T4 + F4: snapshot antigo reaplicado e pulado).
-- ═════════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  v_oid  oid;
  v_def  text;
  v_novo text;
  a1 constant text := '   ORDER BY max(ks.aplicado_em) DESC NULLS LAST, max(ks.created_at) DESC';
  n1 constant text := '   ORDER BY max(ks.generated_at) DESC, max(ks.created_at) DESC  -- (20261013220000) ordem do apply, não aplicado_em';
  v_n int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'snapshot-ref ABORTADA: public.tint_promote_sync_run(uuid) não existe';
  END IF;
  v_def := pg_get_functiondef(v_oid);

  IF position('ORDER BY max(ks.generated_at) DESC' in v_def) > 0 THEN
    RAISE NOTICE 'snapshot-ref já aplicada — no-op';
    RETURN;
  END IF;

  IF position('v_fantasmas_fonte' in v_def) = 0 OR position('AND sf.created_at < v_snap_recebido' in v_def) = 0 THEN
    RAISE EXCEPTION 'snapshot-ref ABORTADA: o promote vivo NÃO tem o #3051 (20261013150000) — aplique-o antes';
  END IF;

  v_n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'snapshot-ref ABORTADA: âncora casou % vez(es) no corpo vivo (esperado 1): [%]', v_n, a1;
  END IF;
  v_novo := replace(v_def, a1, n1);

  EXECUTE v_novo;

  v_def := pg_get_functiondef(v_oid);
  IF position('ORDER BY max(ks.generated_at) DESC' in v_def) = 0
     OR position('max(ks.aplicado_em)' in v_def) > 0
     OR position('AND sf.created_at < v_snap_recebido' in v_def) = 0 THEN
    RAISE EXCEPTION 'snapshot-ref ABORTADA: pós-condição falhou — ordem não trocada ou filtro do #3051 perdido';
  END IF;
END $mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;
