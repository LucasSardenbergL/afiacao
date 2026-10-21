-- Sonda pelo relé (OPTIONS, caminho seguro) da leva busca-confere-documento (PR #3311): omie-vendas-sync v1.25.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
