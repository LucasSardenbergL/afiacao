-- Drop the 4 overly permissive authenticated policies on conversao_unidades.
-- The staff_conversao_unidades_all policy (ALL via has_role) and Service role full access remain.

DROP POLICY IF EXISTS "Authenticated users can view conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "Authenticated users can insert conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "Authenticated users can update conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "Authenticated users can delete conversao_unidades" ON public.conversao_unidades;
