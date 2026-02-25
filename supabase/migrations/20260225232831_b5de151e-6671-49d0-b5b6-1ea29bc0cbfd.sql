
-- Unique constraint on order_items for proper upsert
CREATE UNIQUE INDEX IF NOT EXISTS order_items_sales_order_product_uq
ON public.order_items (sales_order_id, omie_codigo_produto)
WHERE omie_codigo_produto IS NOT NULL;

-- Unique constraint on sync_state for upsert
CREATE UNIQUE INDEX IF NOT EXISTS sync_state_entity_account_uq
ON public.sync_state (entity_type, account);

-- Unique constraint on inventory_position for upsert
CREATE UNIQUE INDEX IF NOT EXISTS inventory_position_produto_account_uq
ON public.inventory_position (omie_codigo_produto, account);

-- Enable pg_cron and pg_net extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
