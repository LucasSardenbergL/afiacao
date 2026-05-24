ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS customer_address text;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS customer_phone text;