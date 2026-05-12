-- 1. Drop overly permissive policy
DROP POLICY IF EXISTS "company_config_authenticated_select" ON public.company_config;

-- 2. Staff-only SELECT
CREATE POLICY "company_config_staff_select"
ON public.company_config
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'employee'::public.app_role)
  OR public.has_role(auth.uid(), 'master'::public.app_role)
);

-- 3. Dedicated SECURITY DEFINER function for the only key clients legitimately need
CREATE OR REPLACE FUNCTION public.get_default_production_assignee()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM public.company_config WHERE key = 'default_production_assignee_id' LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_default_production_assignee() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_default_production_assignee() TO authenticated;