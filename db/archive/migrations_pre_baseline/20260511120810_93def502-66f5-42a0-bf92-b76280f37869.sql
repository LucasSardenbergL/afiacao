-- Drop 4 permissive policies on cache_lotes; staff_cache_lotes_all already covers ALL ops.
DROP POLICY IF EXISTS "Authenticated users can view cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "Authenticated users can insert cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "Authenticated users can update cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "Authenticated users can delete cache_lotes" ON public.cache_lotes;
