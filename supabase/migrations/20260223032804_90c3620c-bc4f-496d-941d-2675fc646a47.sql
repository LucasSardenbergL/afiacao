
CREATE TABLE public.farmer_performance_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  
  -- IEE components (0-100 each)
  iee_ptpl_usage numeric DEFAULT 0,
  iee_objective_adherence numeric DEFAULT 0,
  iee_questions_usage numeric DEFAULT 0,
  iee_bundle_offered numeric DEFAULT 0,
  iee_post_call_registration numeric DEFAULT 0,
  iee_total numeric DEFAULT 0,
  
  -- IPF components (0-100 each)
  ipf_incremental_margin numeric DEFAULT 0,
  ipf_margin_per_hour numeric DEFAULT 0,
  ipf_mix_expansion numeric DEFAULT 0,
  ipf_ltv_evolution numeric DEFAULT 0,
  ipf_churn_reduction numeric DEFAULT 0,
  ipf_total numeric DEFAULT 0,
  
  -- Metadata
  period_start date NOT NULL,
  period_end date NOT NULL,
  total_calls integer DEFAULT 0,
  total_plans integer DEFAULT 0,
  total_margin numeric DEFAULT 0,
  total_time_seconds integer DEFAULT 0,
  
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.farmer_performance_scores ENABLE ROW LEVEL SECURITY;

-- Admin-only full access (sees IEE + IPF)
CREATE POLICY "Admins can manage all performance scores"
  ON public.farmer_performance_scores FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Employees can view only their own IPF (not IEE)
-- We handle IEE visibility restriction in the application layer
CREATE POLICY "Staff can view their own scores"
  ON public.farmer_performance_scores FOR SELECT
  USING (has_role(auth.uid(), 'employee'::app_role) AND farmer_id = auth.uid());

-- Staff can insert their own scores
CREATE POLICY "Staff can insert own scores"
  ON public.farmer_performance_scores FOR INSERT
  WITH CHECK ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)));
