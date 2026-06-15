-- Onda 1 / Fase 1 — reverse-link ligação ↔ pedidos (best-effort).
-- atendimento_id: o MESMO uuid de sales_orders.atendimento_id (cunhado no contexto da ligação).
-- Aditiva, nuável — aplicar via SQL Editor do Lovable.
ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS atendimento_id uuid;

CREATE INDEX IF NOT EXISTS idx_farmer_calls_atendimento_id
  ON public.farmer_calls (atendimento_id) WHERE atendimento_id IS NOT NULL;

SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
     AND table_name='farmer_calls' AND column_name='atendimento_id') AS coluna_1, -- 1
  (SELECT count(*) FROM pg_indexes WHERE indexname='idx_farmer_calls_atendimento_id') AS idx_1; -- 1
