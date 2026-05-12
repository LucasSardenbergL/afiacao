DROP POLICY IF EXISTS "Staff can manage tint_integration_settings" ON public.tint_integration_settings;

CREATE POLICY "Master can manage tint_integration_settings"
ON public.tint_integration_settings
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'master'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role));