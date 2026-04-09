-- Customer segments (tags from Omie + manual)
CREATE TABLE public.customer_segments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  omie_codigo_cliente BIGINT NOT NULL,
  account TEXT NOT NULL DEFAULT 'oben',
  segment TEXT, -- e.g. "Marceneiro", "Serralheiro", "Indústria"
  tags TEXT[] DEFAULT '{}',
  atividade TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (omie_codigo_cliente, account)
);

ALTER TABLE public.customer_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view all segments"
  ON public.customer_segments FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager','employee')));

CREATE POLICY "Staff can manage segments"
  ON public.customer_segments FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager','employee')));

-- Customer preferred items
CREATE TABLE public.customer_preferred_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  omie_codigo_cliente BIGINT NOT NULL,
  omie_codigo_produto BIGINT NOT NULL,
  product_codigo TEXT,
  product_descricao TEXT,
  account TEXT NOT NULL DEFAULT 'oben',
  familia TEXT, -- product family/category
  last_ordered_at TIMESTAMPTZ,
  order_count INT DEFAULT 1,
  added_manually BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (omie_codigo_cliente, omie_codigo_produto, account)
);

ALTER TABLE public.customer_preferred_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view preferred items"
  ON public.customer_preferred_items FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager','employee')));

CREATE POLICY "Staff can manage preferred items"
  ON public.customer_preferred_items FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('admin','manager','employee')));

CREATE TRIGGER update_customer_segments_updated_at
  BEFORE UPDATE ON public.customer_segments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_customer_preferred_items_updated_at
  BEFORE UPDATE ON public.customer_preferred_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();