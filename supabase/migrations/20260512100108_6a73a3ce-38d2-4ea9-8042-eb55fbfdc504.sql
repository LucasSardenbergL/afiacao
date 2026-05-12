-- Replace broad SELECT policies that allow listing all objects in public buckets.
-- Public access to file URLs still works because the buckets are flagged public.
DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view tool photos" ON storage.objects;

CREATE POLICY "Owners can list their avatars"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Owners and staff can list tool photos"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'tool-photos'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR public.has_role(auth.uid(), 'master'::public.app_role)
    OR public.has_role(auth.uid(), 'employee'::public.app_role)
  )
);