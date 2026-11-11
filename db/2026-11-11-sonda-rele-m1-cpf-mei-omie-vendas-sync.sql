-- Sonda pelo relé da omie-vendas-sync v1.35-razao-exibida-sem-cpf (#3831): o relé posta na edge-relé, nunca na alvo.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
