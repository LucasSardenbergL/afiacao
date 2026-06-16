-- ============================================================
-- idx_tactical_plans_lookup — Fase 2 / Fatia 1 (oferta viva na ligação)
-- Acelera dois acessos quentes a farmer_tactical_plans:
--   1. getActivePlan(customerId): plano 'gerado' mais recente do par (farmer, cliente).
--   2. Idempotência do cron tactical-plans-batch: "já há 'gerado' criado hoje?".
-- Ambos filtram por (farmer_id, customer_user_id, status) e ordenam por created_at DESC.
-- Sem o índice, hoje a tabela só tem o pkey em (id) → seq scan (confirmado em prod via psql-ro).
-- Idempotente (IF NOT EXISTS) — não é tabela nova, então não há RLS a declarar.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tactical_plans_lookup
  ON public.farmer_tactical_plans (farmer_id, customer_user_id, status, created_at DESC);
