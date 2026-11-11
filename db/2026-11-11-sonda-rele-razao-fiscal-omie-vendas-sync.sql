-- Sonda pelo relé da omie-vendas-sync v1.34-razao-fiscal-da-outra-conta (#3803): o relé posta na edge-relé, nunca na alvo.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
