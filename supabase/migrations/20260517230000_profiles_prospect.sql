-- PR-CUSTOMERS-MGMT: prospect (cliente novo cadastrado pelo vendedor)
-- Profile flag is_prospect + metadata de origem + traceability pra farmer_calls

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_prospect boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prospect_source text
    CHECK (prospect_source IN ('chamada_inbound', 'chamada_outbound', 'walk_in', 'manual', 'omie_import')),
  ADD COLUMN IF NOT EXISTS prospect_origin_call_id uuid REFERENCES public.farmer_calls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS razao_social text,
  ADD COLUMN IF NOT EXISTS cnpj text;

CREATE INDEX IF NOT EXISTS idx_profiles_is_prospect
  ON public.profiles (is_prospect, created_at DESC)
  WHERE is_prospect = true;

COMMENT ON COLUMN public.profiles.is_prospect IS 'Prospect = cliente cadastrado pelo vendedor (não auto-signup). Auth.users dummy. Quando user real fizer signup, flipa pra false.';
COMMENT ON COLUMN public.profiles.prospect_origin_call_id IS 'Chamada que originou o cadastro (PR-CUSTOMERS-MGMT). Permite traceability.';
