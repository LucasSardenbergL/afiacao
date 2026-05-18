-- PR-CONTACTS: múltiplos contatos por cliente + aniversário da empresa

CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Telefone (campo principal pra busca em resolveCustomerByPhone)
  phone text NOT NULL,

  -- Identificação
  nome text,
  cargo text CHECK (cargo IN ('dono', 'socio', 'gerente', 'comprador', 'secretaria', 'aplicador', 'tecnico', 'outro')),
  email text,

  -- Sinais
  is_decision_maker boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,
  whatsapp_only boolean NOT NULL DEFAULT false,

  -- Relacionamento
  birthday date,
  notas text,

  -- Auditoria
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'omie', 'auto_detected_call', 'auto_import')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer
  ON public.customer_contacts (customer_user_id, is_primary DESC);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_phone
  ON public.customer_contacts (phone);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_contacts_one_primary
  ON public.customer_contacts (customer_user_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_customer_contacts_birthday
  ON public.customer_contacts ((extract(month from birthday)), (extract(day from birthday)))
  WHERE birthday IS NOT NULL;

DROP TRIGGER IF EXISTS trg_customer_contacts_updated_at ON public.customer_contacts;
CREATE TRIGGER trg_customer_contacts_updated_at
  BEFORE UPDATE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_contacts_select_staff" ON public.customer_contacts
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "customer_contacts_insert_staff" ON public.customer_contacts
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "customer_contacts_update_staff" ON public.customer_contacts
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "customer_contacts_delete_master" ON public.customer_contacts
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

ALTER TABLE public.company_profiles
  ADD COLUMN IF NOT EXISTS data_fundacao date;

COMMENT ON TABLE public.customer_contacts IS 'Múltiplos contatos por cliente (dono, gerente, comprador, etc) com aniversário e cargo. Usado em resolveCustomerByPhone pra auto-identificar caller na chamada inbound.';
COMMENT ON COLUMN public.company_profiles.data_fundacao IS 'Aniversário da empresa — usado em automação de relacionamento (PR-BIRTHDAYS futuro).';
