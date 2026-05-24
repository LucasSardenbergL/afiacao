
-- Create a function to refresh the materialized view and return customer metrics
CREATE OR REPLACE FUNCTION public.get_customer_metrics()
RETURNS TABLE (
  customer_user_id uuid,
  razao_social text,
  document text,
  ultima_compra_data timestamptz,
  dias_desde_ultima_compra integer,
  pedidos_90d bigint,
  faturamento_90d numeric,
  ticket_medio_90d numeric,
  faturamento_prev_90d numeric,
  intervalo_medio_dias numeric,
  atraso_relativo numeric,
  is_cold_start boolean,
  calculated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.customer_metrics_mv;
$$;

-- Function to refresh the materialized view (called by the agent)
CREATE OR REPLACE FUNCTION public.refresh_customer_metrics()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.customer_metrics_mv;
$$;
