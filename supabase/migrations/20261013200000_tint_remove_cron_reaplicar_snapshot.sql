-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — remove a MITIGAÇÃO TEMPORÁRIA do #3054 agora que o #3051 está em prod
-- [money-path]
--
-- O #3054 (20261013180000) criou o cron `tint-reaplicar-snapshot-6h`, que remarca o snapshot de
-- chaves aplicado mais recente como `pendente` de 6 em 6h, para o apply voltar a desativar fórmula de
-- cor que a fonte retirou — remendo enquanto o promote ressuscitava fantasma. O cabeçalho dele manda
-- removê-lo quando o #3051 entrar.
--
-- ⚠️ O CRON É INÓCUO — medido, não suposto (psql-ro, 2026-10-13): a execução das 18:30 UTC remarcou
-- o snapshot e o tick o reaplicou às 18:30:01, e o run gravou {"skipped": "fora de ordem"}, deletes=0.
-- O tint_apply_keys_snapshot PULA quando generated_at <= tint_integration_settings.last_keys_snapshot_at,
-- e reaplicar o MESMO snapshot sempre cai aí. Então ele nunca desativou nada: nem fantasma (o que o
-- #3054 pretendia) nem cor nova. A 1ª versão desta migration afirmava que, com o #3051, ele passaria
-- a desativar a cor nova que o critério temporal deixa passar — FALSO, corrigido aqui. A prova do #3054
-- (db/test-tint-reaplicar-snapshot.sh) não executa o apply, por isso não pegou. Medição da sessão
-- "Fila de promoção Tintometrico atrasada", conferida por esta.
--
-- POR QUE REMOVER MESMO ASSIM: o dano real é um ALARME FALSO a cada 6h. Remarcar o snapshot como
-- `pendente` faz o watchdog da fila (que mede a idade pelo created_at do snapshot, 03:08) acusar fila
-- atrasada na hora — foi o alerta "fila de promoção atrasada" das 15:30 BRT de 2026-10-13. Alerta
-- falso recorrente treina o founder a ignorar alertas.
--
-- O QUE FAZ: só desagenda o cron. A função public.tint_reaplicar_snapshot_tick() fica (inerte sem o
-- cron, e o arquivo do #3054 segue no repo como histórico aplicado); dropá-la seria outra decisão.
--
-- GUARDA: ABORTA se o #3051 NÃO estiver no promote vivo. Como o cron é inócuo, ela não protege contra
-- reabrir exposição; é ORDEM: o cabeçalho do #3054 condiciona a remoção ao #3051, e quem aplicar fora
-- de ordem fica sabendo que o conserto real não está em prod. Idempotente: sem o job, é NOTICE e segue.
-- Pós-condição lida do catálogo.
--
-- APLICAR: bun run db:aplicar supabase/migrations/20261013200000_tint_remove_cron_reaplicar_snapshot.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- ═════════════════════════════════════════════════════════════════════════════

DO $rm$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure) INTO v_def;
  IF v_def IS NULL OR position('v_fantasmas_fonte' IN v_def) = 0
     OR position('AND sf.created_at < v_snap_recebido' IN v_def) = 0 THEN
    RAISE EXCEPTION 'remove-cron ABORTADA: o promote vivo NÃO tem a correção do #3051 (20261013150000) — o #3054 condiciona a remoção ao #3051 — aplique o #3051 antes.';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-reaplicar-snapshot-6h') THEN
    PERFORM cron.unschedule('tint-reaplicar-snapshot-6h');
  ELSE
    RAISE NOTICE 'remove-cron: tint-reaplicar-snapshot-6h já não existe — no-op';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-reaplicar-snapshot-6h') THEN
    RAISE EXCEPTION 'remove-cron ABORTADA: pós-condição falhou — o job ainda está agendado';
  END IF;
END
$rm$;
