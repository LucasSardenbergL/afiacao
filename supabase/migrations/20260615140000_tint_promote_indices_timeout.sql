-- tint_promote_sync_run estourava o statement_timeout no FULL RE-SCAN inicial
-- (carga de ~121k fórmulas). Causa: tint_calc_preco_final e o insert de itens
-- filtram tint_staging_formula_itens por staging_formula_id, mas NÃO havia índice
-- nessa coluna (a FK não cria índice automaticamente) → full scan de ~732k linhas
-- por chamada, milhares de vezes por run. Idem nas demais staging filtradas por
-- chave/sync_run_id. Em shadow_mode a promoção nunca roda, por isso o gargalo
-- ficou latente até o flip pra automatic_primary.
--
-- Fix: índices (zero mudança de lógica — só velocidade) + margem de statement_timeout
-- na função de promoção (carga inicial é pesada por natureza; deltas diários são leves).
-- CREATE INDEX IF NOT EXISTS = idempotente. Aplicar com o serviço PARADO (sc stop)
-- para evitar lock contention com a escrita do conector no staging.

-- ── Índice CRÍTICO: itens da fórmula por staging_formula_id ──────────────────
CREATE INDEX IF NOT EXISTS idx_tsfi_staging_formula_id
  ON public.tint_staging_formula_itens (staging_formula_id);

-- ── Corantes por chave (lookup no cálculo de preço) ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_tsc_acct_corante
  ON public.tint_staging_corantes (account, id_corante_sayersystem);

-- ── Fórmulas: join por par (produto,base) e filtro por run ──────────────────
CREATE INDEX IF NOT EXISTS idx_tsf_acct_par
  ON public.tint_staging_formulas (account, cod_produto, id_base);
CREATE INDEX IF NOT EXISTS idx_tsf_run
  ON public.tint_staging_formulas (sync_run_id);

-- ── Demais staging filtradas por sync_run_id (montagem dos _tp_*/_pares) ─────
CREATE INDEX IF NOT EXISTS idx_tss_run    ON public.tint_staging_skus (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tsprod_run ON public.tint_staging_produtos (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tsbase_run ON public.tint_staging_bases (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tsemb_run  ON public.tint_staging_embalagens (sync_run_id);

-- ── Margem de tempo pra promoção da carga inicial ───────────────────────────
-- (SECURITY DEFINER; o SET é aplicado ao entrar na função e re-arma o timeout
--  do statement para este escopo — padrão Supabase para RPC pesada.)
ALTER FUNCTION public.tint_promote_sync_run(uuid) SET statement_timeout = '300s';

SELECT 'INDICES + TIMEOUT OK' AS status;
