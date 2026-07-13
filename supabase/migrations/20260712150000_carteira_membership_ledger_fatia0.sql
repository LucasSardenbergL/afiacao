-- 20260712150000_carteira_membership_ledger_fatia0.sql
-- P0-B-bis Fatia 0: ledger de membership da carteira (acumulador durável) + backfill + trigger.
-- Aditivo: NADA lê o ledger ainda (Fatia 1). RLS espelha omie_clientes.

CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_state text NOT NULL DEFAULT 'verified'
                 CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at timestamptz NOT NULL,
  source        text NOT NULL DEFAULT 'trigger'
                 CHECK (source IN ('backfill','trigger','rpc')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cml_identity_state
  ON public.carteira_membership_ledger (identity_state);

ALTER TABLE public.carteira_membership_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can manage carteira membership ledger" ON public.carteira_membership_ledger;
CREATE POLICY "Staff can manage carteira membership ledger"
  ON public.carteira_membership_ledger FOR ALL
  USING      (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));

DROP POLICY IF EXISTS "Users can view their own membership" ON public.carteira_membership_ledger;
CREATE POLICY "Users can view their own membership"
  ON public.carteira_membership_ledger FOR SELECT
  USING (auth.uid() = user_id);

-- Backfill: 1 linha por user_id do espelho, com a data REAL do vínculo (~março).
INSERT INTO public.carteira_membership_ledger (user_id, first_seen_at, source)
SELECT user_id, created_at, 'backfill'
FROM public.omie_clientes
ON CONFLICT (user_id) DO NOTHING;

-- Trigger: enquanto o espelho ainda é escrito (Fatias 0-3), captura todo user_id novo.
-- ON CONFLICT DO NOTHING → idempotente + coexiste com o backfill.
CREATE OR REPLACE FUNCTION public.tg_omie_clientes_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.carteira_membership_ledger (user_id, first_seen_at, source)
  VALUES (NEW.user_id, COALESCE(NEW.created_at, now()), 'trigger')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_omie_clientes_to_ledger ON public.omie_clientes;
CREATE TRIGGER trg_omie_clientes_to_ledger
  AFTER INSERT ON public.omie_clientes
  FOR EACH ROW EXECUTE FUNCTION public.tg_omie_clientes_to_ledger();
