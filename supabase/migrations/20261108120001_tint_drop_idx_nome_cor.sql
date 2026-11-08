-- Migration: apaga o índice gin trigram idx_tint_formulas_nome_cor (81 MB) de tint_formulas, que nenhum leitor alcança.
-- Evidência e números: docs/historico/retencao-scores-60d.md ("Os outros índices com 0 scans", plano v7 D5).
-- ⚠️ NÃO auto-aplica (nome custom). Tem DROP INDEX → é DDL destrutivo, apply do founder:
-- SQL Editor do Lovable (transação implícita da colagem — por isso o arquivo não leva BEGIN/COMMIT).
--
-- O QUE NÃO MUDA: nenhuma coluna, nenhum dado, nenhuma função, nenhum plano de consulta de hoje. A extensão
-- pg_trgm fica (outros índices trigram dependem dela).
--
-- Diagnóstico (psql-ro, 2026-11-07, postmaster de 2026-10-31 10:33, stats_reset nulo → janela de 7 d):
--   idx_tint_formulas_nome_cor  81 MB  idx_scan = 0, sem constraint dependente.
-- Por que nenhum leitor de hoje pode usá-lo (não é "uso raro", é estrutural):
--   - Os dois leitores, a busca global do Cmd-K (src/hooks/useGlobalSearch.ts) e a tela de fórmulas
--     (src/pages/TintFormulas.tsx), filtram `cor_id ILIKE '%x%' OR nome_cor ILIKE '%x%'` (ilikeOr). cor_id não
--     tem índice trigram, e um OR com um braço sem índice não vira BitmapOr. EXPLAIN em prod: o Cmd-K usa
--     idx_tint_formulas_ativas com filtro e a tela usa uq_tint_formulas_chave com filtro. O controle (só
--     `nome_cor ILIKE`) usa o gin, então o índice funciona; só não há consulta que o peça.
--   - Nenhuma RPC/view filtra nome_cor por LIKE/similarity (pg_proc/pg_views de prod). A tint_promote_sync_run
--     só ESCREVE nome_cor (upsert) — e é aí que o gin custa: manutenção a cada fórmula promovida (~1 M linhas).
-- Ganho: 81 MB de disco e de cache, e a manutenção do gin sai do caminho de escrita do sync tintométrico.
-- Reverter: CREATE INDEX CONCURRENTLY idx_tint_formulas_nome_cor ON public.tint_formulas
--           USING gin (nome_cor extensions.gin_trgm_ops);  (fora de transação; de 20260323134755_…)
-- Se um dia a busca por cor precisar de índice: trigram em cor_id E em nome_cor, senão o OR não usa nenhum.

-- Lock curto: DROP INDEX precisa de ACCESS EXCLUSIVE em tint_formulas. Com leitor/sync longo na frente, falha
-- em 3 s em vez de enfileirar a tela e o sync atrás de si — basta colar de novo.
SET lock_timeout = '3s';

-- PRE: se o índice existe, tem de ser O de 20260323134755 e seguir com 0 scans. Outra definição = alguém o
-- recriou para outro leitor; scan > 0 = apareceu leitor. Nos dois casos, apagar às cegas tiraria esse
-- leitor. Ausente = já aplicado (idempotente).
DO $pre$
DECLARE
  v_def  text;
  v_scan bigint;
BEGIN
  SELECT pg_get_indexdef(c.oid) INTO v_def
    FROM pg_catalog.pg_class c
   WHERE c.oid = to_regclass('public.idx_tint_formulas_nome_cor');
  IF v_def IS NULL THEN
    RETURN;
  END IF;
  -- pg_get_indexdef qualifica a opclass conforme o search_path: no psql-ro sai `extensions.gin_trgm_ops`,
  -- no SQL Editor (role postgres, search_path com `extensions`) sai `gin_trgm_ops`. Normaliza antes de comparar.
  IF replace(v_def, 'extensions.gin_trgm_ops', 'gin_trgm_ops')
       <> 'CREATE INDEX idx_tint_formulas_nome_cor ON public.tint_formulas USING gin (nome_cor gin_trgm_ops)' THEN
    RAISE EXCEPTION 'PRE: idx_tint_formulas_nome_cor mudou de definição (%) — revise quem o lê antes de apagar', v_def;
  END IF;
  SELECT s.idx_scan INTO v_scan
    FROM pg_catalog.pg_stat_user_indexes s
   WHERE s.indexrelid = to_regclass('public.idx_tint_formulas_nome_cor');
  IF coalesce(v_scan, 0) > 0 THEN
    RAISE EXCEPTION 'PRE: idx_tint_formulas_nome_cor tem % scan(s) — apareceu leitor; não apagar sem reler', v_scan;
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.idx_tint_formulas_nome_cor;

-- PÓS: o índice sumiu e os índices com leitor de tint_formulas continuam lá — o drop é de UM.
DO $post$
BEGIN
  IF to_regclass('public.idx_tint_formulas_nome_cor') IS NOT NULL THEN
    RAISE EXCEPTION 'POS: idx_tint_formulas_nome_cor ainda existe';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_index i
       WHERE i.indisvalid
         AND i.indexrelid IN (to_regclass('public.tint_formulas_pkey'),
                              to_regclass('public.uq_tint_formulas_chave'),
                              to_regclass('public.idx_tint_formulas_ativas'),
                              to_regclass('public.idx_tint_formulas_wd5_ativas'))) <> 4 THEN
    RAISE EXCEPTION 'POS: um índice com leitor de tint_formulas sumiu ou está inválido — o drop levou mais de um';
  END IF;
  RAISE NOTICE 'POS ok: idx_tint_formulas_nome_cor apagado; pkey, chave, ativas e wd5_ativas intactos';
END
$post$;

RESET lock_timeout;
