-- Drop 3 permissive policies on picking_tasks; staff_picking_tasks_all covers ALL ops.
DROP POLICY IF EXISTS "Authenticated users can view picking tasks" ON public.picking_tasks;
DROP POLICY IF EXISTS "Authenticated users can insert picking tasks" ON public.picking_tasks;
DROP POLICY IF EXISTS "Authenticated users can update picking tasks" ON public.picking_tasks;
