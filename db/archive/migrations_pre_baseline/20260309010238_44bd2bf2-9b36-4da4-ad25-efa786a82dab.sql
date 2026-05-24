
CREATE TABLE public.route_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL,
  visited_by UUID NOT NULL,
  visit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  visit_type TEXT NOT NULL DEFAULT 'comercial',
  result TEXT,
  notes TEXT,
  revenue_generated NUMERIC(10,2) DEFAULT 0,
  order_created BOOLEAN DEFAULT false,
  lat NUMERIC(10,7),
  lng NUMERIC(10,7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.route_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage route visits"
  ON public.route_visits
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
