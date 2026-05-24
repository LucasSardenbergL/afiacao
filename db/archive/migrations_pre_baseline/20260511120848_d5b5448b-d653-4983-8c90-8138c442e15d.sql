-- Drop 3 permissive policies on picking_task_items; staff_picking_task_items_all covers ALL ops.
DROP POLICY IF EXISTS "Authenticated users can view picking task items" ON public.picking_task_items;
DROP POLICY IF EXISTS "Authenticated users can insert picking task items" ON public.picking_task_items;
DROP POLICY IF EXISTS "Authenticated users can update picking task items" ON public.picking_task_items;
