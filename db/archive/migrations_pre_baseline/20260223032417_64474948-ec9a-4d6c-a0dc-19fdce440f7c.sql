
ALTER TABLE public.farmer_tactical_plans
  ADD COLUMN IF NOT EXISTS plan_type text DEFAULT 'essencial',
  ADD COLUMN IF NOT EXISTS approach_strategy_b text,
  ADD COLUMN IF NOT EXISTS second_bundle jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ltv_projection jsonb,
  ADD COLUMN IF NOT EXISTS expected_result jsonb,
  ADD COLUMN IF NOT EXISTS operational_risks jsonb DEFAULT '[]'::jsonb;
