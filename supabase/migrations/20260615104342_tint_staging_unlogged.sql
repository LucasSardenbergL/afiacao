-- ============================================================
-- tint_staging_unlogged — torna as tabelas de staging do tint UNLOGGED
--
-- Dor (medido 2026-06-15): os INSERT em tint_staging_formula_itens (1,77M
-- blocos escritos) e tint_staging_formulas (806k) são o #1/#2 em escrita do
-- banco inteiro, e CRESCERAM durante a sessão (+2.317 / +1.165 calls) → dreno
-- de write-IO ATIVO. O connector externo empurra o catálogo em lote (já é bulk,
-- chunks de 500/1000 — não é N+1), promove pras tabelas reais (tint_formulas/
-- tint_formula_itens, essas LOGGED/duráveis) e TRUNCA a staging.
--
-- Fix: as staging são SCRATCH (preenche → promove → trunca). UNLOGGED elimina o
-- WAL dessas escritas (parte grande do IO de escrita) sem tocar lógica nenhuma.
-- SEGURO: no crash/restart, a UNLOGGED zera — e o connector re-empurra (ele só
-- avança o high-water mark no sucesso da promoção; ver comentário em
-- tint-sync-agent/index.ts:165). A verdade durável vive nas tabelas tint_*
-- promovidas, não na staging. Parte do plano de otimização de disk IO.
--
-- Idempotente: só altera a tabela que ainda NÃO é unlogged (relpersistence<>'u');
-- tabela ausente é pulada. ALTER ... SET UNLOGGED reescreve a tabela (lock breve);
-- a staging fica vazia entre syncs, então o rewrite é instantâneo. Aplicar quando
-- não houver sync tint em andamento (senão espera o lock por instantes).
-- ============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tint_staging_produtos','tint_staging_bases','tint_staging_embalagens',
    'tint_staging_corantes','tint_staging_skus','tint_staging_formulas',
    'tint_staging_formula_itens','tint_staging_precos_base'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relpersistence <> 'u'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I SET UNLOGGED', t);
    END IF;
  END LOOP;
END $$;
