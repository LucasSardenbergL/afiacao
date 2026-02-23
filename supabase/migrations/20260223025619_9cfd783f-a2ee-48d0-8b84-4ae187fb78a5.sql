
-- Experiments table for A/B testing
CREATE TABLE public.farmer_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  primary_metric TEXT NOT NULL CHECK (primary_metric IN ('margem_por_hora', 'ltv', 'churn', 'receita_incremental')),
  min_duration_days INTEGER NOT NULL DEFAULT 14,
  min_sample_size INTEGER NOT NULL DEFAULT 10,
  min_significance NUMERIC NOT NULL DEFAULT 0.95,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'ativo', 'concluido', 'cancelado')),
  winner TEXT CHECK (winner IN ('controle', 'teste', 'inconclusivo', NULL)),
  control_description TEXT,
  test_description TEXT,
  control_metric_value NUMERIC DEFAULT 0,
  test_metric_value NUMERIC DEFAULT 0,
  lift_pct NUMERIC DEFAULT 0,
  p_value NUMERIC,
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Experiment client assignments
CREATE TABLE public.farmer_experiment_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES public.farmer_experiments(id) ON DELETE CASCADE,
  customer_user_id UUID NOT NULL,
  group_type TEXT NOT NULL CHECK (group_type IN ('controle', 'teste')),
  metric_value NUMERIC DEFAULT 0,
  revenue_generated NUMERIC DEFAULT 0,
  margin_generated NUMERIC DEFAULT 0,
  calls_count INTEGER DEFAULT 0,
  total_time_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE (experiment_id, customer_user_id)
);

-- Enable RLS
ALTER TABLE public.farmer_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_experiment_clients ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Staff can manage experiments"
  ON public.farmer_experiments FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can manage experiment clients"
  ON public.farmer_experiment_clients FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));
