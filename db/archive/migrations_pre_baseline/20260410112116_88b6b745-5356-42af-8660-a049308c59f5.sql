CREATE UNIQUE INDEX idx_profiles_document_unique 
ON public.profiles (document) 
WHERE document IS NOT NULL AND document != '';