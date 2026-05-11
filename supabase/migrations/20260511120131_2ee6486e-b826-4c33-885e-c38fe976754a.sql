-- Drop the 4 overly permissive authenticated policies on cte_associados
-- A staff-only policy already covers ALL operations via has_role

DROP POLICY IF EXISTS "Authenticated users can view cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "Authenticated users can insert cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "Authenticated users can update cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "Authenticated users can delete cte_associados" ON public.cte_associados;

-- Verify remaining policy count for cte_associados
SELECT tablename, count(*) as policy_count 
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'cte_associados' 
GROUP BY tablename;

-- List remaining policies for confirmation
SELECT policyname, cmd, qual::text as qual_text
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'cte_associados'
ORDER BY policyname;
