-- Allow staff (admin + employee) to manage training modules
DROP POLICY IF EXISTS "Only admins can manage training modules" ON public.training_modules;
CREATE POLICY "Staff can manage training modules"
  ON public.training_modules
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));