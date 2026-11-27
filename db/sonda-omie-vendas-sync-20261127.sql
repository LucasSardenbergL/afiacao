-- Sonda pós-deploy de omie-vendas-sync v1.54 (onda 2 do #4250) pelo relé seguro (OPTIONS, sem efeito).
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
