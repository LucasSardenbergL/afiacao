
-- Table to track recommendation offers and outcomes for continuous learning
CREATE TABLE public.farmer_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('cross_sell', 'up_sell')),
  product_id UUID REFERENCES public.omie_products(id),
  current_product_id UUID REFERENCES public.omie_products(id),
  p_ij NUMERIC DEFAULT 0,
  m_ij NUMERIC DEFAULT 0,
  lie NUMERIC DEFAULT 0,
  complexity_factor NUMERIC DEFAULT 1.0,
  cluster_volume_estimate NUMERIC DEFAULT 1,
  offered_at TIMESTAMP WITH TIME ZONE,
  accepted_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,
  actual_margin NUMERIC,
  time_spent_seconds INTEGER,
  status TEXT DEFAULT 'pendente' CHECK (status IN ('pendente', 'ofertado', 'aceito', 'rejeitado', 'expirado')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Table for category conversion rates (learning)
CREATE TABLE public.farmer_category_conversion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id TEXT NOT NULL,
  total_offers INTEGER DEFAULT 0,
  total_accepts INTEGER DEFAULT 0,
  conversion_rate NUMERIC DEFAULT 0,
  avg_margin_generated NUMERIC DEFAULT 0,
  avg_time_spent_seconds INTEGER DEFAULT 0,
  profit_per_hour NUMERIC DEFAULT 0,
  complexity_factor NUMERIC DEFAULT 1.0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_category_conversion ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Staff can manage recommendations"
  ON public.farmer_recommendations FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can manage category conversion"
  ON public.farmer_category_conversion FOR ALL
  USING (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'))
  WITH CHECK (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'employee'));

-- Add unique constraint for category conversion
CREATE UNIQUE INDEX idx_farmer_category_conversion_category ON public.farmer_category_conversion(category_id);
