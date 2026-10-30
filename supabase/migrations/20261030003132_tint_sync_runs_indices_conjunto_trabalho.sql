-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — índices em tint_sync_runs: a promoção (e as telas) param de varrer a tabela inteira
--
-- POR QUÊ (medido, psql-ro): o micro (shared_buffers 256MB) foi reprovado em 29/10 — 1.682 MB lidos
-- do disco em 10 min, cache hit 94,7% (docs/historico/tint-purge-staging-io.md). tint_sync_runs
-- respondeu por 455 MB: 9 seq scans dos 87 MB do heap em 10 min. Quem varre: o PRÓPRIO
-- tint_promote_sync_run, 1 seq scan por promoção (~30/h). Prova: desde o restart de 29/10 19:57 o
-- seq_scan de tint_sync_runs (120) = os scans de tint_staging_bases/_produtos/_embalagens (120 cada,
-- 1 por promoção) = os idx_scan de idx_tint_sync_runs_status (o UPDATE de runs órfãos, 1 por promoção).
-- A consulta é o somatório do cap de limpezas em 24h:
--     WHERE tr.account = v_account AND tr.store_code = v_store
--       AND COALESCE(tr.promovido_em, tr.started_at) > now() - interval '24 hours'
--       AND tr.metadata ? 'receitas_limpas'
-- e nenhum índice cobre account/store_code nem a expressão → 132k linhas lidas para achar ~720.
--
-- O QUE FAZ: só índices + ANALYZE. ZERO mudança de lógica — a promoção (money-path) não é recriada.
--   1. idx_tint_sync_runs_limpezas_24h — casa a consulta do cap de limpezas LITERALMENTE: mesma
--      expressão COALESCE e mesmo predicado parcial (metadata ? 'receitas_limpas'), senão o planner
--      não o considera.
--   2. idx_tint_sync_runs_started_at — TintSyncRuns/TintIntegrations: ORDER BY started_at DESC LIMIT n.
--   3. idx_tint_sync_runs_conta_tipo_inicio — TintDashboard: account + sync_type + started_at
--      (último run e janela de runs de fórmula). Hoje cada abertura relê os 87 MB.
--   ANALYZE: o índice de EXPRESSÃO só ganha estatística da expressão no ANALYZE (o autoanalyze só
--   viria depois de ~13k mudanças, semanas). É REFORÇO da estimativa, não condição: no PG17 local o
--   plano genérico já escolhe o índice sem ele (db/test-tint-sync-runs-indices.sh: 12.715 → 67 buffers).
--
-- COMO APLICAR: `bun run db:aplicar` (a transação é do executor — este arquivo NÃO leva BEGIN/COMMIT).
-- CREATE INDEX comum (não CONCURRENTLY): trava ESCRITA em tint_sync_runs pelo tempo do build
-- (~1 s para 87 MB); leitura segue. lock_timeout do executor (15s) aborta em vez de enfileirar.
-- Idempotente: IF NOT EXISTS; re-aplicar = só o ANALYZE de novo.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_tint_sync_runs_limpezas_24h
  ON public.tint_sync_runs (account, store_code, (COALESCE(promovido_em, started_at)))
  WHERE metadata ? 'receitas_limpas';

CREATE INDEX IF NOT EXISTS idx_tint_sync_runs_started_at
  ON public.tint_sync_runs (started_at);

CREATE INDEX IF NOT EXISTS idx_tint_sync_runs_conta_tipo_inicio
  ON public.tint_sync_runs (account, sync_type, started_at);

ANALYZE public.tint_sync_runs;

DO $post$
DECLARE
  v_idx text;
  v_def text;
BEGIN
  FOREACH v_idx IN ARRAY ARRAY['idx_tint_sync_runs_limpezas_24h',
                               'idx_tint_sync_runs_started_at',
                               'idx_tint_sync_runs_conta_tipo_inicio'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_idx
        AND i.indrelid = 'public.tint_sync_runs'::regclass
        AND i.indisvalid AND i.indisready
    ) THEN
      RAISE EXCEPTION 'A1 FALHOU: % ausente ou inválido em tint_sync_runs — a promoção segue varrendo a tabela inteira', v_idx;
    END IF;
  END LOOP;

  -- Um índice de mesmo NOME com outra forma (IF NOT EXISTS não recria) não serve a consulta do cap.
  SELECT pg_get_indexdef('public.idx_tint_sync_runs_limpezas_24h'::regclass) INTO v_def;
  IF v_def NOT LIKE '%(account, store_code, COALESCE(promovido_em, started_at))%'
     OR v_def NOT LIKE '%WHERE (metadata ? ''receitas_limpas''::text)%' THEN
    RAISE EXCEPTION 'A2 FALHOU: idx_tint_sync_runs_limpezas_24h com forma inesperada (%) — o planner não o casa com a consulta do cap de limpezas', v_def;
  END IF;

  RAISE NOTICE 'tint_sync_runs: 3 índices válidos; limpezas_24h casa a consulta do cap';
END
$post$;
