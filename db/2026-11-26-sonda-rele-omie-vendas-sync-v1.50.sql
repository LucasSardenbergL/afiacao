-- Sonda pós-deploy da omie-vendas-sync v1.50 (PR #4215, deploy de 2026-11-26 16:08Z) pelo relé seguro (OPTIONS).
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
