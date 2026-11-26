-- Sonda pós-deploy da omie-vendas-sync v1.48 (PR #4174, deploy de 2026-11-26 11:18Z) pelo relé seguro (OPTIONS).
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
