DROP POLICY IF EXISTS fin_dre_select ON public.fin_dre_snapshots;
CREATE POLICY fin_dre_select ON public.fin_dre_snapshots
  FOR SELECT TO authenticated
  USING (public.fin_user_can_access(company));