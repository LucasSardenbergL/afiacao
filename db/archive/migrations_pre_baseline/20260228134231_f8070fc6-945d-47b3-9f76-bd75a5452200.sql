
-- Add account column to omie_products
ALTER TABLE omie_products ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'oben';

-- Drop old unique constraint and create new one including account
ALTER TABLE omie_products DROP CONSTRAINT IF EXISTS omie_products_omie_codigo_produto_key;
CREATE UNIQUE INDEX IF NOT EXISTS omie_products_omie_codigo_produto_account_key ON omie_products (omie_codigo_produto, account);

-- Add account column to sales_orders
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'oben';
