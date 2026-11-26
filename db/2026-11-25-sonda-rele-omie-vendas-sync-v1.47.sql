-- Sonda pós-deploy da omie-vendas-sync v1.47 pelo relé seguro (OPTIONS).
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
