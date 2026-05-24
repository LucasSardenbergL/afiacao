
-- Production orders table
CREATE TABLE public.production_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sales_order_id UUID REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  sales_order_number TEXT,
  customer_name TEXT,
  product_id UUID REFERENCES public.omie_products(id),
  product_codigo TEXT,
  product_descricao TEXT,
  quantidade NUMERIC NOT NULL DEFAULT 1,
  unidade TEXT DEFAULT 'UN',
  status TEXT NOT NULL DEFAULT 'pending',
  omie_ordem_producao_id BIGINT,
  omie_ordem_numero TEXT,
  assigned_to UUID,
  ready_by_date DATE,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  account TEXT NOT NULL DEFAULT 'colacor',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.production_orders ENABLE ROW LEVEL SECURITY;

-- Staff (admin/employee) can view all production orders
CREATE POLICY "Staff can view production orders"
  ON public.production_orders FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin','employee','manager'))
  );

-- Staff can create production orders
CREATE POLICY "Staff can create production orders"
  ON public.production_orders FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin','employee','manager'))
  );

-- Staff can update production orders
CREATE POLICY "Staff can update production orders"
  ON public.production_orders FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin','employee','manager'))
  );

-- Trigger for updated_at
CREATE TRIGGER update_production_orders_updated_at
  BEFORE UPDATE ON public.production_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add ready_by_date to sales_orders
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS ready_by_date DATE;

-- Index for quick lookups
CREATE INDEX idx_production_orders_status ON public.production_orders(status);
CREATE INDEX idx_production_orders_assigned ON public.production_orders(assigned_to);
CREATE INDEX idx_production_orders_account ON public.production_orders(account);
