-- =============================================================================
-- TINT_FORMULAS — AUTOVACUUM AGRESSIVO (mantém o visibility map fresco)
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable.
--
-- Contexto: tint_formulas (~965k linhas) recebe importações constantes. O
-- autovacuum default só dispara a 20% de tuples mortas (~193k) → entre rodadas o
-- visibility map degrada (foi visto a 58,5%) → o count exact do dashboard faz
-- Heap Fetches em massa (528k vistos) no Index Only Scan → 5s+ → risco de 500
-- (statement_timeout=8s do authenticated) em cache frio.
--
-- Companheiro do fix de RLS InitPlan (migration 20260627150000): aquele matou o
-- has_role por-linha (13,4s→5,2s); este mantém o Index Only Scan limpo
-- (Heap Fetches ~0) de forma DURÁVEL, evitando a recorrência do count lento.
--
-- Fix: baixar os scale_factors p/ 0.05 → o autovacuum (e o insert-triggered, que
-- seta o vis-map após cargas de INSERT) roda a 5%, não 20%. Tuning puro de
-- performance — não muda dados nem comportamento. Idempotente (re-rodar = no-op).
-- =============================================================================

ALTER TABLE public.tint_formulas SET (
  autovacuum_vacuum_scale_factor  = 0.05,   -- vacuum a 5% de mortas (default 0.20)
  autovacuum_analyze_scale_factor = 0.05,   -- analyze a 5% (estatísticas frescas)
  autovacuum_vacuum_insert_scale_factor = 0.05  -- PG13+: vacuum após 5% de INSERTs → seta o vis-map
);

-- Validação pós-apply (esperado: os 3 params em reloptions)
SELECT relname, reloptions
FROM pg_class WHERE relname = 'tint_formulas';
