DELETE FROM public.purchase_orders_tracking 
WHERE raw_data->'cabec'->>'cModeloNFe' = '57';