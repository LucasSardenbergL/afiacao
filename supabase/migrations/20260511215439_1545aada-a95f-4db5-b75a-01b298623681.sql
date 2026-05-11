-- Staff-only UPDATE/DELETE policies for 'aumentos' bucket
CREATE POLICY "Staff can update aumentos"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'aumentos'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
)
WITH CHECK (
  bucket_id = 'aumentos'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
);

CREATE POLICY "Staff can delete aumentos"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'aumentos'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
);