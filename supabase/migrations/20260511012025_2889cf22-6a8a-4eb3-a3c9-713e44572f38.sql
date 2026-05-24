-- =========================================================================
-- E4 Storage Policies — buckets: aumentos, portal_screenshots, tool-photos
-- =========================================================================

-- -------------------------------------------------------------------------
-- Bloco 1: bucket "aumentos" — adicionar INSERT para staff
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS "Staff upload aumentos" ON storage.objects;

CREATE POLICY "Staff upload aumentos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'aumentos'
  AND (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'master'::public.app_role)
    OR public.has_role(auth.uid(), 'employee'::public.app_role)
  )
);

-- -------------------------------------------------------------------------
-- Bloco 2: bucket "portal_screenshots" — restringir SELECT a staff
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS "portal_screenshots_select_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "portal_screenshots_select_staff" ON storage.objects;

CREATE POLICY "portal_screenshots_select_staff"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'portal_screenshots'
  AND (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'master'::public.app_role)
    OR public.has_role(auth.uid(), 'employee'::public.app_role)
  )
);

-- -------------------------------------------------------------------------
-- Bloco 3: bucket "tool-photos"
--   (a) INSERT exige pasta = uid + authenticated
--   (b) SELECT continua público mas só para name não nulo (sem listar raiz)
-- -------------------------------------------------------------------------
ALTER POLICY "Authenticated users can upload tool photos"
ON storage.objects
WITH CHECK (
  bucket_id = 'tool-photos'
  AND auth.role() = 'authenticated'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

ALTER POLICY "Anyone can view tool photos"
ON storage.objects
USING (
  bucket_id = 'tool-photos'
  AND name IS NOT NULL
  AND (storage.foldername(name))[1] IS NOT NULL
);