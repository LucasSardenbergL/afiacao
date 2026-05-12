DROP POLICY IF EXISTS "Anyone can read company config" ON public.company_config;

CREATE POLICY "Authenticated users can read non-sensitive company config"
ON public.company_config
FOR SELECT
TO authenticated
USING (key NOT LIKE 'nvoip_%');

CREATE POLICY "Staff can read all company config"
ON public.company_config
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'master'::app_role)
  OR public.has_role(auth.uid(), 'employee'::app_role)
);