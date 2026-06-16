-- Hardening de RLS em farmer_client_scores e customer_visit_scores (idempotente; já aplicada em prod, este arquivo alinha repo×prod)

ALTER TABLE public.farmer_client_scores  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_visit_scores ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('farmer_client_scores','customer_visit_scores')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

CREATE POLICY fcs_select_carteira ON public.farmer_client_scores
  FOR SELECT USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY fcs_insert_own_or_gestor ON public.farmer_client_scores
  FOR INSERT WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY fcs_update_own_or_gestor ON public.farmer_client_scores
  FOR UPDATE
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY fcs_delete_own_or_gestor ON public.farmer_client_scores
  FOR DELETE USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY cvs_select_carteira ON public.customer_visit_scores
  FOR SELECT USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );

CREATE POLICY cvs_insert_own_or_gestor ON public.customer_visit_scores
  FOR INSERT WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY cvs_update_own_or_gestor ON public.customer_visit_scores
  FOR UPDATE
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );

CREATE POLICY cvs_delete_own_or_gestor ON public.customer_visit_scores
  FOR DELETE USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );