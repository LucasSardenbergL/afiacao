
-- Fix PUBLIC_DATA_EXPOSURE: Replace USING(true) service role policies with staff-scoped policies

-- 1. omie_clientes: Drop permissive service role policy, add staff policy
DROP POLICY IF EXISTS "Service role can manage omie clients" ON public.omie_clientes;

CREATE POLICY "Staff can manage omie clients"
  ON public.omie_clientes FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 2. omie_ordens_servico: Drop permissive policy, add scoped policies
DROP POLICY IF EXISTS "Service role can manage omie os" ON public.omie_ordens_servico;

CREATE POLICY "Users can view their own order sync data"
  ON public.omie_ordens_servico FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders 
      WHERE orders.id = omie_ordens_servico.order_id 
      AND orders.user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can manage order sync data"
  ON public.omie_ordens_servico FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 3. omie_servicos: Drop permissive service role policy, add staff management policy
DROP POLICY IF EXISTS "Service role can manage omie services" ON public.omie_servicos;

CREATE POLICY "Staff can manage omie services"
  ON public.omie_servicos FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 4. tool_events: Replace public SELECT with owner-scoped (keep existing owner/staff policies)
DROP POLICY IF EXISTS "Public can view tool events via tool id" ON public.tool_events;

-- 5. company_config: Restrict public SELECT to only non-sensitive keys
DROP POLICY IF EXISTS "Anyone can read company config" ON public.company_config;

CREATE POLICY "Authenticated users can read non-sensitive config"
  ON public.company_config FOR SELECT
  TO authenticated
  USING (key NOT IN ('master_cnpj', 'master_cpf'));
