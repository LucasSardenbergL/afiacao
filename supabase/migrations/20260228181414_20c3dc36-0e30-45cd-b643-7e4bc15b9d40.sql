
-- Table to log each reprocessing execution
CREATE TABLE public.sync_reprocess_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL, -- 'orders', 'products', 'inventory', 'costs', 'association_rules'
  account text NOT NULL DEFAULT 'vendas',
  reprocess_type text NOT NULL DEFAULT 'operational', -- 'operational' (7d) or 'strategic' (30d)
  window_start timestamp with time zone NOT NULL,
  window_end timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'running', -- 'running', 'complete', 'error'
  upserts_count integer DEFAULT 0,
  deletes_count integer DEFAULT 0,
  divergences_found integer DEFAULT 0,
  corrections_applied integer DEFAULT 0,
  duration_ms integer DEFAULT 0,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.sync_reprocess_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage reprocess logs" ON public.sync_reprocess_log
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Configurable windows
CREATE TABLE public.sync_reprocess_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value integer NOT NULL,
  description text,
  updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.sync_reprocess_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage reprocess config" ON public.sync_reprocess_config
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- Insert default config values
INSERT INTO public.sync_reprocess_config (key, value, description) VALUES
  ('operational_window_days', 7, 'Janela móvel operacional (dias) - reprocessada a cada sync incremental'),
  ('strategic_window_days', 30, 'Janela móvel estratégica (dias) - reprocessada no job diário'),
  ('operational_enabled', 1, 'Habilitar reprocessamento operacional (1=sim, 0=não)'),
  ('strategic_enabled', 1, 'Habilitar reprocessamento estratégico (1=sim, 0=não)');

-- Add hash_payload column to sales_orders for change detection
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS hash_payload text;

-- Add hash_payload column to order_items for change detection
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS hash_payload text;

-- Index for efficient window queries
CREATE INDEX IF NOT EXISTS idx_sync_reprocess_log_created ON public.sync_reprocess_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_reprocess_log_entity ON public.sync_reprocess_log (entity_type, account, reprocess_type);
CREATE INDEX IF NOT EXISTS idx_sales_orders_updated ON public.sales_orders (updated_at);
