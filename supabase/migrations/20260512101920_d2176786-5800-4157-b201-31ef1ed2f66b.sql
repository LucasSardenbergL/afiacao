-- Revoke EXECUTE from authenticated/anon/public on functions only invoked by edge functions (service_role bypasses RLS and these grants).
-- These functions are NOT called from the frontend; they are server-side only.

REVOKE EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tint_run_reconciliation(uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_metrics() FROM authenticated, anon, PUBLIC;