
-- Client health & priority scores (cached, recalculated periodically)
CREATE TABLE public.farmer_client_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL,
  farmer_id UUID NOT NULL,
  -- Health Score components (0-1 each)
  rf_score NUMERIC DEFAULT 0,
  m_score NUMERIC DEFAULT 0,
  g_score NUMERIC DEFAULT 0,
  x_score NUMERIC DEFAULT 0,
  s_score NUMERIC DEFAULT 0,
  health_score NUMERIC DEFAULT 0,
  health_class TEXT DEFAULT 'critico',
  -- Priority Score components (0-100 each)
  churn_risk NUMERIC DEFAULT 0,
  recover_score NUMERIC DEFAULT 0,
  expansion_score NUMERIC DEFAULT 0,
  eff_score NUMERIC DEFAULT 0,
  priority_score NUMERIC DEFAULT 0,
  -- Raw data snapshots
  days_since_last_purchase INTEGER DEFAULT 0,
  avg_repurchase_interval NUMERIC DEFAULT 0,
  avg_monthly_spend_180d NUMERIC DEFAULT 0,
  gross_margin_pct NUMERIC DEFAULT 0,
  category_count INTEGER DEFAULT 0,
  answer_rate_60d NUMERIC DEFAULT 0,
  whatsapp_reply_rate_60d NUMERIC DEFAULT 0,
  revenue_potential NUMERIC DEFAULT 0,
  -- Timestamps
  calculated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(customer_user_id, farmer_id)
);
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage client scores" ON public.farmer_client_scores FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Daily agenda
CREATE TABLE public.farmer_agenda (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  agenda_date DATE NOT NULL DEFAULT CURRENT_DATE,
  priority_score NUMERIC DEFAULT 0,
  agenda_type TEXT NOT NULL DEFAULT 'follow_up',
  status TEXT DEFAULT 'pendente',
  completed_at TIMESTAMPTZ,
  call_id UUID REFERENCES public.farmer_calls(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.farmer_agenda ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage agenda" ON public.farmer_agenda FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Governance proposals
CREATE TABLE public.farmer_governance_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by UUID NOT NULL,
  proposal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  current_params JSONB NOT NULL DEFAULT '{}',
  proposed_params JSONB NOT NULL DEFAULT '{}',
  impact_revenue_pct NUMERIC,
  impact_margin_pct NUMERIC,
  impact_churn_pct NUMERIC,
  impact_margin_per_hour NUMERIC,
  status TEXT DEFAULT 'aguardando_aprovacao',
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  algorithm_version TEXT DEFAULT 'v1.0',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.farmer_governance_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage governance proposals" ON public.farmer_governance_proposals FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Audit log
CREATE TABLE public.farmer_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  performed_by UUID NOT NULL,
  algorithm_version TEXT DEFAULT 'v1.0',
  previous_params JSONB,
  new_params JSONB,
  projection JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.farmer_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage audit log" ON public.farmer_audit_log FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Add WhatsApp tracking to farmer_calls
ALTER TABLE public.farmer_calls ADD COLUMN IF NOT EXISTS is_whatsapp BOOLEAN DEFAULT false;
ALTER TABLE public.farmer_calls ADD COLUMN IF NOT EXISTS whatsapp_replied BOOLEAN DEFAULT false;

-- Algorithm config table for k1, k2, CatTarget and other tunable params
CREATE TABLE public.farmer_algorithm_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value NUMERIC NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.farmer_algorithm_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view algorithm config" ON public.farmer_algorithm_config FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Staff can manage algorithm config" ON public.farmer_algorithm_config FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
