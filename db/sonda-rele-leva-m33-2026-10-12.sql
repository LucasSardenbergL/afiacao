-- Sonda pelo relé (OPTIONS) das 3 edges da leva M-33 que têm o caminho seguro — 2026-10-12, após o deploy pelo MCP.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['copilot-analyze', 'generate-bundle-argument', 'generate-tactical-plan']);
