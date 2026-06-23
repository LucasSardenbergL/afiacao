-- ============================================================================
-- sales_history_status: degradação honesta do health (ausente≠zero no OUTPUT).
-- text NULL + CHECK. NULL = "ainda não computado" → a UI se comporta como hoje
-- (NÃO esconde health, NÃO assume sem_historico). Espelha health_class (text, sem enum).
-- + config próprio sales_active_threshold_days (desacoplado de hs_recency_cap_days).
-- Spec: docs/superpowers/specs/2026-06-20-sales-history-status-design.md
-- ============================================================================
ALTER TABLE public.farmer_client_scores
  ADD COLUMN IF NOT EXISTS sales_history_status text;

ALTER TABLE public.farmer_client_scores
  DROP CONSTRAINT IF EXISTS farmer_client_scores_sales_history_status_check;
ALTER TABLE public.farmer_client_scores
  ADD CONSTRAINT farmer_client_scores_sales_history_status_check
  CHECK (sales_history_status IS NULL OR sales_history_status IN ('sem_historico','stale','ativo'));

-- config próprio (value é numeric NOT NULL). WHERE NOT EXISTS = idempotente sem depender de UNIQUE(key).
INSERT INTO public.farmer_algorithm_config (key, value, description)
SELECT 'sales_active_threshold_days', 180,
       'Limiar (dias) p/ sales_history_status ativo vs stale — desacoplado de hs_recency_cap_days'
WHERE NOT EXISTS (
  SELECT 1 FROM public.farmer_algorithm_config WHERE key = 'sales_active_threshold_days'
);
