
-- Update RLS policies on financial tables to use fin_user_can_access instead of admin/manager check
-- This allows users with fin_permissoes or admin/manager roles to access the data

DROP POLICY IF EXISTS fin_cc_select ON public.fin_contas_correntes;
CREATE POLICY fin_cc_select ON public.fin_contas_correntes
  FOR SELECT TO authenticated
  USING (public.fin_user_can_access(company));

DROP POLICY IF EXISTS fin_cr_select ON public.fin_contas_receber;
CREATE POLICY fin_cr_select ON public.fin_contas_receber
  FOR SELECT TO authenticated
  USING (public.fin_user_can_access(company));

DROP POLICY IF EXISTS fin_cp_select ON public.fin_contas_pagar;
CREATE POLICY fin_cp_select ON public.fin_contas_pagar
  FOR SELECT TO authenticated
  USING (public.fin_user_can_access(company));

-- Also fix movimentacoes
DROP POLICY IF EXISTS fin_mov_select ON public.fin_movimentacoes;
CREATE POLICY fin_mov_select ON public.fin_movimentacoes
  FOR SELECT TO authenticated
  USING (public.fin_user_can_access(company));
