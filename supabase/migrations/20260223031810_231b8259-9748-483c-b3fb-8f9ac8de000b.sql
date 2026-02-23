
-- Pre-call tactical plans
CREATE TABLE public.farmer_tactical_plans (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  bundle_recommendation_id UUID REFERENCES public.farmer_bundle_recommendations(id),
  
  -- Diagnosis
  health_score NUMERIC DEFAULT 0,
  churn_risk NUMERIC DEFAULT 0,
  mix_gap INTEGER DEFAULT 0,
  current_margin_pct NUMERIC DEFAULT 0,
  cluster_avg_margin_pct NUMERIC DEFAULT 0,
  expansion_potential NUMERIC DEFAULT 0,
  
  -- Strategy
  strategic_objective TEXT NOT NULL DEFAULT 'expansao_mix',
  customer_profile TEXT DEFAULT 'misto',
  
  -- Bundle
  top_bundle JSONB DEFAULT '{}'::jsonb,
  bundle_lie NUMERIC DEFAULT 0,
  bundle_probability NUMERIC DEFAULT 0,
  bundle_incremental_margin NUMERIC DEFAULT 0,
  best_individual_lie NUMERIC DEFAULT 0,
  
  -- Questions & objections (AI-generated)
  diagnostic_questions JSONB DEFAULT '[]'::jsonb,
  implication_question TEXT,
  offer_transition TEXT,
  probable_objections JSONB DEFAULT '[]'::jsonb,
  approach_strategy TEXT,
  
  -- Post-call tracking
  plan_followed BOOLEAN,
  call_result TEXT,
  actual_margin NUMERIC,
  call_duration_seconds INTEGER,
  objection_type TEXT,
  notes TEXT,
  
  -- Effectiveness
  effectiveness_score NUMERIC,
  
  status TEXT DEFAULT 'gerado',
  generated_at TIMESTAMPTZ DEFAULT now(),
  used_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage tactical plans" ON public.farmer_tactical_plans
  FOR ALL USING (
    has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  ) WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  );
