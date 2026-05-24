-- Replace permissive INSERT/UPDATE on warehouses with staff-only policies.
-- Keep SELECT (authenticated read) and Service role full access untouched.

DROP POLICY IF EXISTS "Authenticated users can insert warehouses" ON public.warehouses;
DROP POLICY IF EXISTS "Authenticated users can update warehouses" ON public.warehouses;

CREATE POLICY "staff_warehouses_insert" ON public.warehouses
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "staff_warehouses_update" ON public.warehouses
  FOR UPDATE TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  )
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  );
