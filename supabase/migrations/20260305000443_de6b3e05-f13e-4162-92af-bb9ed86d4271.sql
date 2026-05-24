
-- Grant access to the materialized view for authenticated users (via service role in edge function)
GRANT SELECT ON public.customer_metrics_mv TO authenticated;
GRANT SELECT ON public.customer_metrics_mv TO service_role;
