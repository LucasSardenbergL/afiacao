-- Sonda pelo relé (OPTIONS, caminho seguro) da leva retorno-documento-estrito (PR #3359): omie-vendas-sync v1.26.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
