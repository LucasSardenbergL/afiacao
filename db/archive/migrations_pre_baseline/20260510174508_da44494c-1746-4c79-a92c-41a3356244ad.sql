-- RLS PHASE 2: Staff-only policies (admin/employee/manager/master), admin-only roadmap_state, cleanups
-- Idempotent: uses DROP POLICY IF EXISTS and DROP/CREATE pattern.

-- =========================================================
-- Helper macro values (inline): staff = admin|employee|manager|master
-- =========================================================

-- ---------- purchase_orders_tracking ----------
DROP POLICY IF EXISTS "authenticated_all_purchase_orders_tracking" ON public.purchase_orders_tracking;
DROP POLICY IF EXISTS "staff_purchase_orders_tracking_all" ON public.purchase_orders_tracking;
CREATE POLICY "staff_purchase_orders_tracking_all" ON public.purchase_orders_tracking
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- reposition_parameters ----------
DROP POLICY IF EXISTS "authenticated_all_reposition_parameters" ON public.reposition_parameters;
DROP POLICY IF EXISTS "staff_reposition_parameters_all" ON public.reposition_parameters;
CREATE POLICY "staff_reposition_parameters_all" ON public.reposition_parameters
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- abc_xyz_classification ----------
DROP POLICY IF EXISTS "authenticated_all_abc_xyz_classification" ON public.abc_xyz_classification;
DROP POLICY IF EXISTS "staff_abc_xyz_classification_all" ON public.abc_xyz_classification;
CREATE POLICY "staff_abc_xyz_classification_all" ON public.abc_xyz_classification
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- sku_leadtime_history ----------
DROP POLICY IF EXISTS "authenticated_all_sku_leadtime_history" ON public.sku_leadtime_history;
DROP POLICY IF EXISTS "staff_sku_leadtime_history_all" ON public.sku_leadtime_history;
CREATE POLICY "staff_sku_leadtime_history_all" ON public.sku_leadtime_history
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- roadmap_state (admin-only) ----------
DROP POLICY IF EXISTS "authenticated_all_roadmap_state" ON public.roadmap_state;
DROP POLICY IF EXISTS "admin_roadmap_state_all" ON public.roadmap_state;
CREATE POLICY "admin_roadmap_state_all" ON public.roadmap_state
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- ---------- cte_associados ----------
DROP POLICY IF EXISTS "authenticated_select_cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "authenticated_insert_cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "authenticated_update_cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "authenticated_delete_cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "authenticated_all_cte_associados" ON public.cte_associados;
DROP POLICY IF EXISTS "staff_cte_associados_all" ON public.cte_associados;
CREATE POLICY "staff_cte_associados_all" ON public.cte_associados
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- conversao_unidades ----------
DROP POLICY IF EXISTS "authenticated_select_conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "authenticated_insert_conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "authenticated_update_conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "authenticated_delete_conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "authenticated_all_conversao_unidades" ON public.conversao_unidades;
DROP POLICY IF EXISTS "staff_conversao_unidades_all" ON public.conversao_unidades;
CREATE POLICY "staff_conversao_unidades_all" ON public.conversao_unidades
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- cache_lotes ----------
DROP POLICY IF EXISTS "authenticated_select_cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "authenticated_insert_cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "authenticated_update_cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "authenticated_delete_cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "authenticated_all_cache_lotes" ON public.cache_lotes;
DROP POLICY IF EXISTS "staff_cache_lotes_all" ON public.cache_lotes;
CREATE POLICY "staff_cache_lotes_all" ON public.cache_lotes
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- picking_tasks ----------
DROP POLICY IF EXISTS "authenticated_select_picking_tasks" ON public.picking_tasks;
DROP POLICY IF EXISTS "authenticated_insert_picking_tasks" ON public.picking_tasks;
DROP POLICY IF EXISTS "authenticated_update_picking_tasks" ON public.picking_tasks;
DROP POLICY IF EXISTS "authenticated_all_picking_tasks" ON public.picking_tasks;
DROP POLICY IF EXISTS "staff_picking_tasks_all" ON public.picking_tasks;
CREATE POLICY "staff_picking_tasks_all" ON public.picking_tasks
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- picking_task_items ----------
DROP POLICY IF EXISTS "authenticated_select_picking_task_items" ON public.picking_task_items;
DROP POLICY IF EXISTS "authenticated_insert_picking_task_items" ON public.picking_task_items;
DROP POLICY IF EXISTS "authenticated_update_picking_task_items" ON public.picking_task_items;
DROP POLICY IF EXISTS "authenticated_all_picking_task_items" ON public.picking_task_items;
DROP POLICY IF EXISTS "staff_picking_task_items_all" ON public.picking_task_items;
CREATE POLICY "staff_picking_task_items_all" ON public.picking_task_items
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- picking_events ----------
DROP POLICY IF EXISTS "authenticated_select_picking_events" ON public.picking_events;
DROP POLICY IF EXISTS "authenticated_insert_picking_events" ON public.picking_events;
DROP POLICY IF EXISTS "authenticated_update_picking_events" ON public.picking_events;
DROP POLICY IF EXISTS "authenticated_all_picking_events" ON public.picking_events;
DROP POLICY IF EXISTS "staff_picking_events_all" ON public.picking_events;
CREATE POLICY "staff_picking_events_all" ON public.picking_events
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- sku_parametros (SELECT staff only; preserve existing write policies) ----------
DROP POLICY IF EXISTS "authenticated read sku_parametros" ON public.sku_parametros;
DROP POLICY IF EXISTS "staff_sku_parametros_select" ON public.sku_parametros;
CREATE POLICY "staff_sku_parametros_select" ON public.sku_parametros
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- sku_parametros_historico (SELECT staff only) ----------
DROP POLICY IF EXISTS "authenticated read sku_parametros_historico" ON public.sku_parametros_historico;
DROP POLICY IF EXISTS "staff_sku_parametros_historico_select" ON public.sku_parametros_historico;
CREATE POLICY "staff_sku_parametros_historico_select" ON public.sku_parametros_historico
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- inventory_position (SELECT staff only) ----------
DROP POLICY IF EXISTS "Authenticated can view inventory" ON public.inventory_position;
DROP POLICY IF EXISTS "staff_inventory_position_select" ON public.inventory_position;
CREATE POLICY "staff_inventory_position_select" ON public.inventory_position
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role) OR has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- ---------- fornecedor_alerta (drop catch-all admin_full_access) ----------
DROP POLICY IF EXISTS "admin_full_access_fornecedor_alerta" ON public.fornecedor_alerta;

-- ---------- venda_items_history cleanup ----------
DROP POLICY IF EXISTS "authenticated users read venda_items_history" ON public.venda_items_history;
DROP POLICY IF EXISTS "authenticated read venda_items_history" ON public.venda_items_history;

-- Defensive sweep: drop any remaining USING(true) policies on venda_items_history granted to authenticated (not service_role only)
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'venda_items_history'
  LOOP
    IF (pol.qual = 'true' OR pol.with_check = 'true')
       AND 'authenticated' = ANY(pol.roles)
       AND pol.policyname NOT LIKE 'staff_%'
    THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.venda_items_history', pol.policyname);
    END IF;
  END LOOP;
END $$;
