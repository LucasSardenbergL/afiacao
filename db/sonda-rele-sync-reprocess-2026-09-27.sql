-- Sonda pós-deploy da sync-reprocess (leva de 2026-09-27 16:42Z, v1.9-revert-changes-lovable)
-- pelo caminho SEGURO: OPTIONS via relé, o mesmo do cron de sonda (a edge está na allowlist).
-- O gerador `sonda:sql` recusa o POST direto para ela — num bundle velho ele executaria o fluxo real.
-- Aplicado por `bun run db:aplicar`; a resposta entra no ledger em ≤ 15 min (`bun run pendencias:deploy`).
SELECT * FROM public.deploy_sonda_disparar(ARRAY['sync-reprocess']);
