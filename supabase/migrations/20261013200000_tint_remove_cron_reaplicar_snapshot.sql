-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — remove a MITIGAÇÃO TEMPORÁRIA do #3054 agora que o #3051 está em prod
-- [money-path]
--
-- O #3054 (20261013180000) criou o cron `tint-reaplicar-snapshot-6h`, que remarca o snapshot de
-- chaves aplicado mais recente como `pendente` de 6 em 6h para o apply voltar a desativar fórmula
-- de cor que a fonte retirou — um remendo enquanto o promote ainda ressuscitava fantasma. O
-- cabeçalho dele manda removê-lo quando o #3051 entrar, e explica por quê: com o #3051 aplicado,
-- reaplicar o snapshot VELHO desativa exatamente o que o critério temporal do #3051 deixa passar
-- de propósito — a cor NOVA cujo staging chegou depois do snapshot. Os dois juntos = o falso
-- positivo que o #3051 foi desenhado para evitar.
--
-- O #3051 (20261013150000) foi aplicado em prod em 2026-10-13 (db:aplicar, tentativa #427). O
-- cron seguia ativo (última execução 18:30 UTC, próxima 00:30 UTC).
--
-- O QUE FAZ: só desagenda o cron. A função public.tint_reaplicar_snapshot_tick() fica (inerte sem
-- o cron, e o arquivo do #3054 segue no repo como histórico aplicado); dropá-la seria outra decisão.
--
-- GUARDA (fail-closed): ABORTA se o #3051 NÃO estiver no promote vivo. Sem ele, remover esta
-- mitigação reabriria a exposição (fórmula de cor retirada ativa e precificável o dia inteiro).
-- Idempotente: sem o job, é NOTICE e segue. Pós-condição lida do catálogo.
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
    RAISE EXCEPTION 'remove-cron ABORTADA: o promote vivo NÃO tem a correção do #3051 (20261013150000) — remover a mitigação agora reabriria a exposição. Aplique o #3051 antes.';
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
