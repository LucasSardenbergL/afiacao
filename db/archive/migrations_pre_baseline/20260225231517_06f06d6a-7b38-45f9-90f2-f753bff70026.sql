
-- ============================================
-- PARTE 1: Analytics Schema for Recommendation Engine
-- ============================================

-- 1. Sync State: track incremental sync per entity/account
CREATE TABLE IF NOT EXISTS public.sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  account text NOT NULL DEFAULT 'vendas',
  last_sync_at timestamptz,
  last_page integer DEFAULT 0,
  last_cursor text,
  total_synced integer DEFAULT 0,
  status text DEFAULT 'idle',
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_state_entity_account ON public.sync_state(entity_type, account);

ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage sync state" ON public.sync_state
  FOR ALL USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  );

-- 2. Order Items: normalized from sales_orders.items JSONB for analytics
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL DEFAULT 0,
  discount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_customer ON public.order_items(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON public.order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_sales_order ON public.order_items(sales_order_id);

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage order items" ON public.order_items
  FOR ALL USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  );

-- 3. Inventory Position: detailed stock with CMC
CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  saldo numeric DEFAULT 0,
  cmc numeric DEFAULT 0,
  preco_medio numeric DEFAULT 0,
  account text NOT NULL DEFAULT 'vendas',
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_omie_account ON public.inventory_position(omie_codigo_produto, account);

ALTER TABLE public.inventory_position ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage inventory" ON public.inventory_position
  FOR ALL USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  );

CREATE POLICY "Authenticated can view inventory" ON public.inventory_position
  FOR SELECT USING (true);

-- 4. Extend product_costs with cost source tracking
ALTER TABLE public.product_costs
  ADD COLUMN IF NOT EXISTS cmc numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_source text DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS cost_confidence numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS family_category text,
  ADD COLUMN IF NOT EXISTS cost_final numeric DEFAULT 0;

-- 5. Add family columns to omie_products for grouping
ALTER TABLE public.omie_products
  ADD COLUMN IF NOT EXISTS familia text,
  ADD COLUMN IF NOT EXISTS subfamilia text;

-- 6. Recommendation log: track impressions, accepts, rejects for optimization
CREATE TABLE IF NOT EXISTS public.recommendation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  recommendation_type text NOT NULL DEFAULT 'cross_sell',
  score_final numeric DEFAULT 0,
  score_assoc numeric DEFAULT 0,
  score_eip numeric DEFAULT 0,
  score_sim numeric DEFAULT 0,
  score_ctx numeric DEFAULT 0,
  explanation_text text,
  explanation_key text,
  unit_cost numeric DEFAULT 0,
  cost_source text,
  margin numeric DEFAULT 0,
  probability numeric DEFAULT 0,
  eip numeric DEFAULT 0,
  event_type text DEFAULT 'impression',
  quantity_suggested numeric DEFAULT 1,
  quantity_accepted numeric DEFAULT 0,
  margin_realized numeric DEFAULT 0,
  sales_order_id uuid REFERENCES public.sales_orders(id),
  mode text DEFAULT 'profit',
  weights jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rec_log_customer ON public.recommendation_log(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_rec_log_product ON public.recommendation_log(product_id);
CREATE INDEX IF NOT EXISTS idx_rec_log_farmer ON public.recommendation_log(farmer_id);
CREATE INDEX IF NOT EXISTS idx_rec_log_event ON public.recommendation_log(event_type);

ALTER TABLE public.recommendation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage recommendation log" ON public.recommendation_log
  FOR ALL USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  );

-- 7. Engine config: weights and thresholds for the recommendation engine
CREATE TABLE IF NOT EXISTS public.recommendation_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value numeric NOT NULL DEFAULT 0,
  description text,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.recommendation_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage rec config" ON public.recommendation_config
  FOR ALL USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  ) WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'employee')
  );

-- Insert default config values
INSERT INTO public.recommendation_config (key, value, description) VALUES
  ('w_assoc', 0.25, 'Peso do score de associação'),
  ('w_eip', 0.35, 'Peso do lucro incremental esperado'),
  ('w_sim', 0.20, 'Peso da similaridade por cluster'),
  ('w_ctx', 0.20, 'Peso do contexto'),
  ('l_min', 1.2, 'Lift mínimo para regras de associação'),
  ('s_min', 0.01, 'Support mínimo para regras'),
  ('margem_default_global', 0.35, 'Margem padrão global para fallback de custo'),
  ('margem_minima', 0.05, 'Margem mínima para sanity check'),
  ('margem_maxima', 0.85, 'Margem máxima para sanity check'),
  ('top_n_vendedor', 5, 'Quantidade de sugestões visíveis para vendedor'),
  ('top_n_admin', 20, 'Quantidade de sugestões visíveis para admin'),
  ('epsilon_exploration', 0.10, 'Taxa de exploração para A/B testing'),
  ('mode', 0, 'Modo: 0=Lucro, 1=LTV'),
  ('kappa_ltv', 0.5, 'Peso de recorrência no modo LTV'),
  ('divergence_threshold', 0.20, 'Limiar de divergência custo produto vs CMC')
ON CONFLICT (key) DO NOTHING;

-- 8. Trigger to update updated_at on sync_state
CREATE TRIGGER update_sync_state_updated_at
  BEFORE UPDATE ON public.sync_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_inventory_updated_at
  BEFORE UPDATE ON public.inventory_position
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
