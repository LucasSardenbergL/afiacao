
-- Picking tasks
CREATE TABLE public.picking_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sales_order_id UUID REFERENCES public.sales_orders(id),
  account TEXT NOT NULL DEFAULT 'colacor',
  status TEXT NOT NULL DEFAULT 'pendente',
  assigned_to UUID,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.picking_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view picking tasks"
  ON public.picking_tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert picking tasks"
  ON public.picking_tasks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update picking tasks"
  ON public.picking_tasks FOR UPDATE TO authenticated USING (true);

CREATE TRIGGER update_picking_tasks_updated_at
  BEFORE UPDATE ON public.picking_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Picking task items
CREATE TABLE public.picking_task_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  picking_task_id UUID NOT NULL REFERENCES public.picking_tasks(id) ON DELETE CASCADE,
  omie_codigo_produto BIGINT,
  product_codigo TEXT,
  product_descricao TEXT,
  quantidade INTEGER NOT NULL DEFAULT 1,
  quantidade_separada INTEGER NOT NULL DEFAULT 0,
  localizacao TEXT,
  lote_fefo TEXT,
  validade_fefo DATE,
  lote_separado TEXT,
  justificativa_substituicao TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  separado_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.picking_task_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view picking task items"
  ON public.picking_task_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert picking task items"
  ON public.picking_task_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update picking task items"
  ON public.picking_task_items FOR UPDATE TO authenticated USING (true);

CREATE TRIGGER update_picking_task_items_updated_at
  BEFORE UPDATE ON public.picking_task_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Picking events log
CREATE TABLE public.picking_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  picking_task_id UUID NOT NULL REFERENCES public.picking_tasks(id) ON DELETE CASCADE,
  picking_task_item_id UUID REFERENCES public.picking_task_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  user_id UUID,
  lote_informado TEXT,
  lote_esperado TEXT,
  justificativa TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.picking_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view picking events"
  ON public.picking_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert picking events"
  ON public.picking_events FOR INSERT TO authenticated WITH CHECK (true);

-- Cache for Omie lot queries
CREATE TABLE public.cache_lotes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cache_lotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view cache_lotes"
  ON public.cache_lotes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert cache_lotes"
  ON public.cache_lotes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update cache_lotes"
  ON public.cache_lotes FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete cache_lotes"
  ON public.cache_lotes FOR DELETE TO authenticated USING (true);

CREATE INDEX idx_cache_lotes_key ON public.cache_lotes(cache_key);
CREATE INDEX idx_cache_lotes_expires ON public.cache_lotes(expires_at);
CREATE INDEX idx_picking_tasks_status ON public.picking_tasks(status);
CREATE INDEX idx_picking_task_items_task ON public.picking_task_items(picking_task_id);
