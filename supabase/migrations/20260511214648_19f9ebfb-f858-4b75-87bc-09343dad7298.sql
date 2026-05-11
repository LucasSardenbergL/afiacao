DROP POLICY IF EXISTS "Staff deleta promocoes" ON storage.objects;
CREATE POLICY "Staff deleta promocoes" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'promocoes' AND (
      public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role)
    )
  );

DROP POLICY IF EXISTS "Staff atualiza promocoes" ON storage.objects;
CREATE POLICY "Staff atualiza promocoes" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'promocoes' AND (
      public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role)
    )
  )
  WITH CHECK (
    bucket_id = 'promocoes' AND (
      public.has_role(auth.uid(), 'admin'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role)
      OR public.has_role(auth.uid(), 'employee'::app_role)
    )
  );