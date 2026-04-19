ALTER TABLE public.sku_leadtime_history 
  ADD CONSTRAINT uq_sku_hist_tracking_sku 
  UNIQUE (tracking_id, sku_codigo_omie);