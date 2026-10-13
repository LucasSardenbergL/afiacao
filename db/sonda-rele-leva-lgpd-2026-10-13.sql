-- Sonda pelo relé (OPTIONS, caminho seguro) da edge da leva de LGPD (#3026, PII fora do log) que tem o ramo.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
