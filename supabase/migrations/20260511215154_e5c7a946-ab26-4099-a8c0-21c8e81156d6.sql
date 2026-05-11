-- E8b: Add INSERT policy for staff on 'promocoes' bucket
CREATE POLICY "Staff can upload promocoes"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'promocoes'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
);