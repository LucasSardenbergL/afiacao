DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'company_config'
      AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.company_config', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "company_config_authenticated_select"
ON public.company_config
FOR SELECT
TO authenticated
USING (key NOT LIKE 'nvoip_%' AND key NOT IN ('master_cnpj', 'master_cpf'));