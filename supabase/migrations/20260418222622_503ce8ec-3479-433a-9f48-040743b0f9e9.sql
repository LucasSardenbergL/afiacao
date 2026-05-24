ALTER TABLE public.purchase_orders_tracking 
ADD COLUMN IF NOT EXISTS match_cte_metodo text;