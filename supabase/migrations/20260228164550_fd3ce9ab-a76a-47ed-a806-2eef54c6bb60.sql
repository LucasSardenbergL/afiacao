
-- HealthScoreHistory: historical snapshots of client health scores
CREATE TABLE public.health_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  health_score numeric NOT NULL DEFAULT 0,
  health_class text NOT NULL DEFAULT 'critico',
  rf_score numeric DEFAULT 0,
  m_score numeric DEFAULT 0,
  g_score numeric DEFAULT 0,
  x_score numeric DEFAULT 0,
  s_score numeric DEFAULT 0,
  churn_risk numeric DEFAULT 0,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.health_score_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage health history"
  ON public.health_score_history
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE INDEX idx_health_history_customer ON public.health_score_history(customer_user_id, calculated_at DESC);
CREATE INDEX idx_health_history_farmer ON public.health_score_history(farmer_id, calculated_at DESC);

-- PriorityScoreLog: daily priority score snapshots
CREATE TABLE public.priority_score_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  priority_score numeric NOT NULL DEFAULT 0,
  margin_potential_component numeric DEFAULT 0,
  churn_risk_component numeric DEFAULT 0,
  repurchase_component numeric DEFAULT 0,
  goal_proximity_component numeric DEFAULT 0,
  score_date date NOT NULL DEFAULT CURRENT_DATE,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.priority_score_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage priority log"
  ON public.priority_score_log
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE INDEX idx_priority_log_farmer_date ON public.priority_score_log(farmer_id, score_date DESC);
CREATE INDEX idx_priority_log_customer ON public.priority_score_log(customer_user_id, score_date DESC);
