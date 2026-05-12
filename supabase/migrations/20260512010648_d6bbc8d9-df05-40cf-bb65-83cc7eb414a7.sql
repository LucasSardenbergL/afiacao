DROP POLICY IF EXISTS "Authenticated users can read non-sensitive company config" ON public.company_config;
DROP POLICY IF EXISTS "Staff can read all company config" ON public.company_config;
DROP POLICY IF EXISTS "Authenticated users can read non-sensitive config" ON public.company_config;

CREATE POLICY "Authenticated users can read non-sensitive company config"
  ON public.company_config
  FOR SELECT
  TO authenticated
  USING (
    key NOT LIKE 'nvoip_%'
    AND key NOT IN ('master_cnpj', 'master_cpf')
  );