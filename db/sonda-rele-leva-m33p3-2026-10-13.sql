-- Sonda pelo relé (OPTIONS, caminho seguro) da edge da leva M-33 p3 (#3028, 8267ee2d8) que tem o ramo.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
