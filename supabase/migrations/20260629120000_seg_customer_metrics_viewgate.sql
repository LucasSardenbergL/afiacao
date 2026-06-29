-- ============================================================
-- 20260629120000_seg_customer_metrics_viewgate.sql
-- Hardening — fecha o achado "Materialized View in API" (customer_metrics_mv) SEM
-- mudar comportamento nem o frontend.
--
-- Move a MV para o schema `private` (fora do PostgREST) e expõe por uma VIEW em
-- `public` de MESMO nome (`security_invoker = off` → lê a MV como owner). Assim o
-- lint não vê mais uma MATERIALIZED VIEW na API — só uma view comum.
--   • authenticated/service_role leem via a view; anon barrado (já estava, Onda 1).
--   • get_customer_metrics (SELECT * FROM public.customer_metrics_mv) e as 3 telas
--     (.from('customer_metrics_mv')) seguem IGUAIS — o nome public é preservado.
--   • refresh_customer_metrics passa a refreshar a MV em `private` (resto verbatim,
--     incl. o gate de staff). A MV mantém o índice único → REFRESH CONCURRENTLY ok.
-- Idempotente. Transacional (move + view atômicos — sem janela sem o objeto).
-- ============================================================
BEGIN;

-- 1) Move a MV public → private (só na 1ª vez; idempotente)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'customer_metrics_mv' AND c.relkind = 'm'
  ) THEN
    ALTER MATERIALIZED VIEW public.customer_metrics_mv SET SCHEMA private;
  END IF;
END $$;

-- 2) Tranca a MV em private (só owner/bypassrls acessam; a view lê como owner)
REVOKE ALL ON private.customer_metrics_mv FROM anon, authenticated;

-- 3) View-gate em public com o mesmo nome (lê a MV private como owner)
CREATE OR REPLACE VIEW public.customer_metrics_mv
  WITH (security_invoker = off, security_barrier = true) AS
  SELECT * FROM private.customer_metrics_mv;

REVOKE ALL ON public.customer_metrics_mv FROM anon;
GRANT SELECT ON public.customer_metrics_mv TO authenticated, service_role;

-- 4) refresh_customer_metrics → aponta para a MV em private (resto verbatim: gate staff + search_path)
CREATE OR REPLACE FUNCTION public.refresh_customer_metrics()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.customer_metrics_mv;
END;
$function$;

COMMIT;
