
-- Insert master_cpf into company_config
INSERT INTO public.company_config (key, value) 
VALUES ('master_cpf', '01363383647')
ON CONFLICT DO NOTHING;

-- Create function to auto-assign super_admin for master CPF on profile insert
CREATE OR REPLACE FUNCTION public.auto_assign_commercial_super_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  master_cpf_value TEXT;
  profile_doc TEXT;
BEGIN
  IF TG_OP != 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.is_employee != true THEN
    RETURN NEW;
  END IF;

  SELECT value INTO master_cpf_value FROM public.company_config WHERE key = 'master_cpf';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');

  IF profile_doc = master_cpf_value THEN
    INSERT INTO public.commercial_roles (user_id, commercial_role)
    VALUES (NEW.user_id, 'super_admin')
    ON CONFLICT (user_id) DO UPDATE SET commercial_role = 'super_admin', updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_commercial_super_admin ON public.profiles;
CREATE TRIGGER trg_auto_commercial_super_admin
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_commercial_super_admin();

-- Allow super_admin commercial role users to also manage commercial_roles
CREATE POLICY "Super admins can manage commercial roles"
  ON public.commercial_roles
  FOR ALL
  TO authenticated
  USING (is_super_admin(auth.uid()))
  WITH CHECK (is_super_admin(auth.uid()));
