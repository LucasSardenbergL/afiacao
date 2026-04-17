CREATE TABLE IF NOT EXISTS public.company_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account TEXT UNIQUE NOT NULL,
  legal_name TEXT NOT NULL,
  cnpj TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.company_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated staff can read company profiles"
  ON public.company_profiles FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "Admins can insert company profiles"
  ON public.company_profiles FOR INSERT
  TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'master'::app_role));

CREATE POLICY "Admins can update company profiles"
  ON public.company_profiles FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'master'::app_role));

CREATE POLICY "Admins can delete company profiles"
  ON public.company_profiles FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'master'::app_role));

CREATE TRIGGER update_company_profiles_updated_at
  BEFORE UPDATE ON public.company_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.company_profiles (account, legal_name, cnpj, phone, address) VALUES
  ('oben', 'OBEN COMÉRCIO LTDA', '51.027.034/0001-00', '(37) 9987-8190', 'Av. Primeiro de Junho, 70 – Centro, Divinópolis/MG – CEP: 35.500-002'),
  ('colacor', 'COLACOR COMERCIAL LTDA', '15.422.799/0001-81', '(37) 3222-1035', 'Av. Primeiro de Junho, 48 – Centro, Divinópolis/MG – CEP: 35.500-002'),
  ('afiacao', 'COLACOR S.C LTDA', '55.555.305/0001-51', '(37) 9987-8190', 'Av. Primeiro de Junho, 50 – Centro, Divinópolis/MG – CEP: 35.500-002')
ON CONFLICT (account) DO NOTHING;