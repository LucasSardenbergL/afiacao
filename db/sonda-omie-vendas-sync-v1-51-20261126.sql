-- Sonda da omie-vendas-sync v1.51-gate-v2-sem-veredito-segue (crédito-IA 6b, opção b), deploy de
-- 2026-11-26 16:22Z pelo Lovable MCP (43/43 hashes contra a main d5f0b163e). Caminho SEGURO: relé
-- (OPTIONS), nunca POST direto na edge. A resposta entra no ledger em ≤ 15 min: `bun run pendencias:deploy`.
SELECT * FROM public.deploy_sonda_disparar(ARRAY['omie-vendas-sync']);
