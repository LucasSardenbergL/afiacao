
-- NFe tables: restrict to staff
DROP POLICY IF EXISTS "Authenticated users can view nfe_recebimentos" ON public.nfe_recebimentos;
DROP POLICY IF EXISTS "Authenticated users can insert nfe_recebimentos" ON public.nfe_recebimentos;
DROP POLICY IF EXISTS "Authenticated users can update nfe_recebimentos" ON public.nfe_recebimentos;

CREATE POLICY "Staff can view nfe_recebimentos" ON public.nfe_recebimentos
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can insert nfe_recebimentos" ON public.nfe_recebimentos
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can update nfe_recebimentos" ON public.nfe_recebimentos
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

DROP POLICY IF EXISTS "Authenticated users can view nfe_recebimento_itens" ON public.nfe_recebimento_itens;
DROP POLICY IF EXISTS "Authenticated users can insert nfe_recebimento_itens" ON public.nfe_recebimento_itens;
DROP POLICY IF EXISTS "Authenticated users can update nfe_recebimento_itens" ON public.nfe_recebimento_itens;
DROP POLICY IF EXISTS "Authenticated users can delete nfe_recebimento_itens" ON public.nfe_recebimento_itens;

CREATE POLICY "Staff can view nfe_recebimento_itens" ON public.nfe_recebimento_itens
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can insert nfe_recebimento_itens" ON public.nfe_recebimento_itens
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can update nfe_recebimento_itens" ON public.nfe_recebimento_itens
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can delete nfe_recebimento_itens" ON public.nfe_recebimento_itens
  FOR DELETE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

DROP POLICY IF EXISTS "Authenticated users can view nfe_lotes_escaneados" ON public.nfe_lotes_escaneados;
DROP POLICY IF EXISTS "Authenticated users can insert nfe_lotes_escaneados" ON public.nfe_lotes_escaneados;
DROP POLICY IF EXISTS "Authenticated users can update nfe_lotes_escaneados" ON public.nfe_lotes_escaneados;

CREATE POLICY "Staff can view nfe_lotes_escaneados" ON public.nfe_lotes_escaneados
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can insert nfe_lotes_escaneados" ON public.nfe_lotes_escaneados
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can update nfe_lotes_escaneados" ON public.nfe_lotes_escaneados
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Referrals: remove referrer access to PII column by dropping direct-table SELECT for referrers
DROP POLICY IF EXISTS "Users can view their own referrals" ON public.referrals;

-- Safe view for referrers: own rows without referred_email
CREATE OR REPLACE VIEW public.referrals_for_referrer
WITH (security_invoker = true)
AS
SELECT
  id,
  referrer_id,
  referred_user_id,
  status,
  points_awarded,
  created_at,
  converted_at
FROM public.referrals
WHERE referrer_id = auth.uid();

GRANT SELECT ON public.referrals_for_referrer TO authenticated;
