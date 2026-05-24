-- Vendor SIP credentials per user — habilita multi-vendedor no WebRTC dialer
-- Cada usuário staff pode ter seu próprio ramal SIP atribuído.
-- Service role usa pra lookup (na edge nvoip-sip-creds); master role gerencia via UI.

CREATE TABLE IF NOT EXISTS public.vendor_sip_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  sip_user text NOT NULL,
  sip_pass text NOT NULL,
  sip_caller_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_sip_credentials IS
  'SIP credentials per user for WebRTC dialer. Service role reads via auth.uid(); master role manages via /admin/sip-credentials UI.';
COMMENT ON COLUMN public.vendor_sip_credentials.sip_pass IS
  'Plaintext SIP password. Protected by RLS (master+service_role only). Encryption at rest pode entrar em PR futuro via pgsodium.';

-- RLS
ALTER TABLE public.vendor_sip_credentials ENABLE ROW LEVEL SECURITY;

-- Master role pode ver tudo (pra UI de admin)
CREATE POLICY "Master can read all vendor SIP credentials"
  ON public.vendor_sip_credentials
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'
    )
  );

-- Master role pode inserir
CREATE POLICY "Master can insert vendor SIP credentials"
  ON public.vendor_sip_credentials
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'
    )
  );

-- Master role pode atualizar
CREATE POLICY "Master can update vendor SIP credentials"
  ON public.vendor_sip_credentials
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'
    )
  );

-- Master role pode deletar
CREATE POLICY "Master can delete vendor SIP credentials"
  ON public.vendor_sip_credentials
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'
    )
  );

-- Trigger updated_at automático
CREATE OR REPLACE FUNCTION public.update_vendor_sip_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vendor_sip_credentials_updated_at_trigger
  BEFORE UPDATE ON public.vendor_sip_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.update_vendor_sip_credentials_updated_at();

-- Index pra lookup rápido por user_id (já é UNIQUE, mas explicito pra clareza)
CREATE INDEX IF NOT EXISTS idx_vendor_sip_credentials_user_id
  ON public.vendor_sip_credentials(user_id);
