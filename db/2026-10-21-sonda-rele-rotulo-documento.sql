-- Sonda pelo relé (OPTIONS, caminho seguro) da leva rótulo-documento (PR #3289): omie-vendas-sync v1.23, omie-analytics-sync (fonte).
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync', 'omie-analytics-sync']);
