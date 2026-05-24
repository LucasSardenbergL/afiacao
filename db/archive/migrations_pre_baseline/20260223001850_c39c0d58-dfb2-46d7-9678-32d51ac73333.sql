-- Tabela de produtos sincronizados da 2ª empresa Omie (Vendas)
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  omie_codigo_produto_integracao text,
  codigo text NOT NULL,
  descricao text NOT NULL,
  unidade text NOT NULL DEFAULT 'UN',
  ncm text,
  valor_unitario numeric NOT NULL DEFAULT 0,
  estoque numeric DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true,
  imagem_url text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(omie_codigo_produto)
);

ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view products"
  ON public.omie_products FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Staff can manage products"
  ON public.omie_products FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Tabela de pedidos de venda
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho',
  notes text,
  omie_pedido_id bigint,
  omie_numero_pedido text,
  omie_payload jsonb,
  omie_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage sales orders"
  ON public.sales_orders FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Customers can view their own sales orders"
  ON public.sales_orders FOR SELECT TO authenticated
  USING (auth.uid() = customer_user_id);

-- Histórico de preços de venda por cliente/produto
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.omie_products(id) ON DELETE CASCADE,
  unit_price numeric NOT NULL,
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sales_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage sales price history"
  ON public.sales_price_history FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

CREATE POLICY "Customers can view their own price history"
  ON public.sales_price_history FOR SELECT TO authenticated
  USING (auth.uid() = customer_user_id);

-- Triggers para updated_at
CREATE TRIGGER update_omie_products_updated_at
  BEFORE UPDATE ON public.omie_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sales_orders_updated_at
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();