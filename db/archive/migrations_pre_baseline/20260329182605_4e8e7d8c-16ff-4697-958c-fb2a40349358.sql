ALTER TABLE public.tint_sync_runs
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_response jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tint_sync_runs_idempotency
  ON public.tint_sync_runs (setting_id, sync_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;