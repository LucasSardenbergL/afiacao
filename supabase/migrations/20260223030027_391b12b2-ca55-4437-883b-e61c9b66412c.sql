
-- Bundle recommendations table
CREATE TABLE public.farmer_bundle_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  bundle_products JSONB NOT NULL DEFAULT '[]',
  bundle_type TEXT NOT NULL DEFAULT 'association',
  support NUMERIC DEFAULT 0,
  confidence NUMERIC DEFAULT 0,
  lift NUMERIC DEFAULT 0,
  p_bundle NUMERIC DEFAULT 0,
  m_bundle NUMERIC DEFAULT 0,
  lie_bundle NUMERIC DEFAULT 0,
  complexity_factor NUMERIC DEFAULT 1.0,
  status TEXT DEFAULT 'pendente' CHECK (status IN ('pendente','ofertado','aceito_total','aceito_parcial','rejeitado')),
  offered_at TIMESTAMP WITH TIME ZONE,
  accepted_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,
  actual_margin NUMERIC,
  time_spent_seconds INTEGER,
  accepted_products JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Association rules cache table
CREATE TABLE public.farmer_association_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  antecedent_product_ids TEXT[] NOT NULL,
  consequent_product_ids TEXT[] NOT NULL,
  support NUMERIC NOT NULL DEFAULT 0,
  confidence NUMERIC NOT NULL DEFAULT 0,
  lift NUMERIC NOT NULL DEFAULT 0,
  rule_type TEXT NOT NULL DEFAULT 'association' CHECK (rule_type IN ('association','sequential')),
  cluster_segment TEXT,
  sample_size INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.farmer_bundle_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_association_rules ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Staff can manage bundle recommendations"
  ON public.farmer_bundle_recommendations FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can manage association rules"
  ON public.farmer_association_rules FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));
