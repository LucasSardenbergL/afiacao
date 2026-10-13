-- Sonda pelo relé (OPTIONS, caminho seguro) das edges da leva do revert do bot do Lovable (#3041) que têm o ramo.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-analytics-sync', 'process-recurring-orders']);
