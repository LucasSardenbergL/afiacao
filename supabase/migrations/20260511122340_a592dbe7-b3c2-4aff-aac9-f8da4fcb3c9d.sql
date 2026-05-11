-- E6 Bloco 1: Habilitar RLS em tabelas expostas sem RLS
ALTER TABLE public.calendario_feriados ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_calendario_feriados_select"
ON public.calendario_feriados
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'master'::app_role)
  OR public.has_role(auth.uid(), 'employee'::app_role)
);

-- E6 Bloco 2: RLS em realtime.messages restringindo topics sensitivos a staff
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_only_nfe_recebimentos_topic"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  topic NOT LIKE 'nfe_recebimentos%'
  OR public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'master'::app_role)
  OR public.has_role(auth.uid(), 'employee'::app_role)
);

CREATE POLICY "staff_only_farmer_calls_topic"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  topic NOT LIKE 'farmer_calls%'
  OR public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'master'::app_role)
  OR public.has_role(auth.uid(), 'employee'::app_role)
);