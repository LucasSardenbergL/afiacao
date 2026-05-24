
-- Enums for call tracking
CREATE TYPE public.farmer_call_type AS ENUM ('reativacao', 'cross_sell', 'up_sell', 'follow_up');
CREATE TYPE public.farmer_call_result AS ENUM ('contato_sucesso', 'sem_resposta', 'ocupado', 'caixa_postal', 'numero_invalido', 'reagendado');

-- Product cost prices for margin calculation
CREATE TABLE public.product_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.omie_products(id) ON DELETE CASCADE,
  cost_price NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id)
);

ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage product costs"
  ON public.product_costs FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Staff can view product costs"
  ON public.product_costs FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Farmer call log
CREATE TABLE public.farmer_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  call_type public.farmer_call_type NOT NULL,
  call_result public.farmer_call_result NOT NULL DEFAULT 'sem_resposta',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER DEFAULT 0,
  follow_up_duration_seconds INTEGER DEFAULT 0,
  attempt_number INTEGER DEFAULT 1,
  notes TEXT,
  linked_sales_order_id UUID REFERENCES public.sales_orders(id),
  revenue_generated NUMERIC DEFAULT 0,
  margin_generated NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.farmer_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage farmer calls"
  ON public.farmer_calls FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Farmers can view their own calls"
  ON public.farmer_calls FOR SELECT
  USING (auth.uid() = farmer_id);

-- Farmer configuration (working hours, preferences)
CREATE TABLE public.farmer_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL UNIQUE,
  hours_weekday NUMERIC NOT NULL DEFAULT 8.83,
  hours_friday NUMERIC NOT NULL DEFAULT 8.33,
  working_days_per_month INTEGER NOT NULL DEFAULT 22,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.farmer_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage farmer config"
  ON public.farmer_config FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Farmer learning weights (auto-adjusted after 30 days)
CREATE TABLE public.farmer_learning_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL UNIQUE,
  weight_recency NUMERIC DEFAULT 0.3,
  weight_frequency NUMERIC DEFAULT 0.2,
  weight_monetary NUMERIC DEFAULT 0.3,
  weight_margin NUMERIC DEFAULT 0.2,
  agenda_pct_risk NUMERIC DEFAULT 0.40,
  agenda_pct_recovery NUMERIC DEFAULT 0.30,
  agenda_pct_expansion NUMERIC DEFAULT 0.30,
  suggested_calls_per_day INTEGER,
  suggested_portfolio_size INTEGER,
  last_adjusted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.farmer_learning_weights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage learning weights"
  ON public.farmer_learning_weights FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Enable realtime for farmer_calls
ALTER PUBLICATION supabase_realtime ADD TABLE public.farmer_calls;
