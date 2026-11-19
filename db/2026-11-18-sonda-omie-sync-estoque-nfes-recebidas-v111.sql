-- Sonda pelo relé (OPTIONS, caminho seguro) das edges deployadas no fecho da sessão do lote mínimo.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-sync-estoque','omie-sync-nfes-recebidas']);
