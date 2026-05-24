-- Staff-only INSERT/UPDATE/DELETE policies for 'portal_screenshots' bucket
CREATE POLICY "Staff can upload portal_screenshots"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'portal_screenshots'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
);

CREATE POLICY "Staff can update portal_screenshots"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'portal_screenshots'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
)
WITH CHECK (
  bucket_id = 'portal_screenshots'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
);

CREATE POLICY "Staff can delete portal_screenshots"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'portal_screenshots'
  AND (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
    OR public.has_role(auth.uid(), 'employee'::app_role)
  )
);