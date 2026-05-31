-- visitas_agendadas: fila persistente de visitas datadas, owner-scoped.
-- Idempotente: pode rerodar (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE).
CREATE TABLE IF NOT EXISTS public.visitas_agendadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  scheduled_by uuid NOT NULL,
  scheduled_date date NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  visit_type text NOT NULL DEFAULT 'comercial',
  notes text,
  route_visit_id uuid REFERENCES public.route_visits(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visitas_agendadas_status_check CHECK (status IN ('pendente','realizada','cancelada'))
);

-- Anti-duplicata: 1 pendente por (cliente, vendedor, data).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vag_pendente_cliente_vendedor_data
  ON public.visitas_agendadas (customer_user_id, scheduled_by, scheduled_date)
  WHERE status = 'pendente';
-- Uma visita realizada fecha no máximo uma agenda.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vag_route_visit_id
  ON public.visitas_agendadas (route_visit_id)
  WHERE route_visit_id IS NOT NULL;
-- Calendário do vendedor.
CREATE INDEX IF NOT EXISTS idx_vag_scheduled_by_date
  ON public.visitas_agendadas (scheduled_by, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_vag_pending_by_seller
  ON public.visitas_agendadas (scheduled_by, scheduled_date)
  WHERE status = 'pendente';

-- updated_at automático.
CREATE OR REPLACE FUNCTION public.set_updated_at_visitas_agendadas()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_vag_updated_at ON public.visitas_agendadas;
CREATE TRIGGER trg_vag_updated_at
  BEFORE UPDATE ON public.visitas_agendadas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_visitas_agendadas();

-- RLS + grants endurecidos.
ALTER TABLE public.visitas_agendadas ENABLE ROW LEVEL SECURITY;

-- ⚠️ Supabase concede privilégios DEFAULT em tabela nova do public p/ anon/authenticated.
-- Sem REVOKE primeiro, o GRANT por coluna NÃO surte efeito (o UPDATE cheio default fica).
REVOKE ALL ON public.visitas_agendadas FROM anon, authenticated, PUBLIC;

GRANT SELECT, INSERT ON public.visitas_agendadas TO authenticated;
GRANT UPDATE (scheduled_date, visit_type, notes, status) ON public.visitas_agendadas TO authenticated;
-- (sem UPDATE em scheduled_by/customer_user_id/route_visit_id → imutáveis; sem DELETE; anon sem nada)

DROP POLICY IF EXISTS "vag_select_own" ON public.visitas_agendadas;
CREATE POLICY "vag_select_own" ON public.visitas_agendadas
  FOR SELECT TO authenticated
  USING (
    scheduled_by = (SELECT auth.uid())
    OR (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "vag_insert_own_carteira" ON public.visitas_agendadas;
CREATE POLICY "vag_insert_own_carteira" ON public.visitas_agendadas
  FOR INSERT TO authenticated
  WITH CHECK (
    scheduled_by = (SELECT auth.uid())
    AND public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
    AND status = 'pendente'
    AND route_visit_id IS NULL
  );

DROP POLICY IF EXISTS "vag_update_own_pending" ON public.visitas_agendadas;
CREATE POLICY "vag_update_own_pending" ON public.visitas_agendadas
  FOR UPDATE TO authenticated
  USING (
    scheduled_by = (SELECT auth.uid())
    AND status = 'pendente'
  )
  WITH CHECK (
    scheduled_by = (SELECT auth.uid())
    AND status IN ('pendente','cancelada')
    AND route_visit_id IS NULL
  );

DROP POLICY IF EXISTS "vag_delete_gestor" ON public.visitas_agendadas;
CREATE POLICY "vag_delete_gestor" ON public.visitas_agendadas
  FOR DELETE TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- Reconciliação: check-in no route_visits fecha a agenda pendente correspondente.
CREATE OR REPLACE FUNCTION public.reconcile_visita_agendada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fecha a agenda pendente DEVIDA (scheduled_date <= data do check-in) MAIS ANTIGA
  -- deste cliente+vendedor. O `<=` cobre visitas ATRASADAS (scheduled_date < hoje).
  -- Futuras (scheduled_date > visit_date) NÃO são fechadas.
  -- Os filtros externos `va.status='pendente' AND va.route_visit_id IS NULL` tornam
  -- um 2º check-in concorrente um no-op (não sobrescreve o route_visit_id do 1º).
  -- O NOT EXISTS impede um mesmo route_visit fechar uma 2ª agenda num re-disparo.
  UPDATE public.visitas_agendadas va
  SET status = 'realizada',
      route_visit_id = NEW.id,
      updated_at = now()
  WHERE va.id = (
    SELECT v.id FROM public.visitas_agendadas v
    WHERE v.customer_user_id = NEW.customer_user_id
      AND v.scheduled_by    = NEW.visited_by
      AND v.status = 'pendente'
      AND v.route_visit_id IS NULL
      AND v.scheduled_date <= NEW.visit_date
    ORDER BY v.scheduled_date ASC
    LIMIT 1
  )
  AND va.status = 'pendente'
  AND va.route_visit_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.visitas_agendadas v2 WHERE v2.route_visit_id = NEW.id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconcile_visita_agendada ON public.route_visits;
CREATE TRIGGER trg_reconcile_visita_agendada
  AFTER INSERT OR UPDATE OF check_in_at ON public.route_visits
  FOR EACH ROW
  WHEN (NEW.check_in_at IS NOT NULL)
  EXECUTE FUNCTION public.reconcile_visita_agendada();
