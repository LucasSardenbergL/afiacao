-- Sobe a frequência do recompute de custo (computeCosts) de 1×/dia (07h) para a cada 2h.
--
-- POR QUÊ (money-path · decisão Claude+Codex 2026-06-22, 2 rodadas adversárias):
-- Os 2 seed writers de product_costs — omie-analytics-sync (syncInventory, ~30min) e
-- sync-reprocess (~2h) — inserem produto NOVO como cost_source='CMC', cost_confidence=0.7,
-- cost_price=cmc SEM aplicar computeCostLadder: ou seja, sem o guard anti-lixo (cmc/price)
-- e sem classificar CMC_MARGEM_ATIPICA. O computeCosts (AUTORIDADE — aplica o ladder em todo
-- ativo com preço) reconcilia, mas rodava só 1×/dia, enquanto o seed semeia a cada 30min/2h.
-- Resultado: janela de até ~24h em que um cmc-lixo recém-semeado entra cru no cockpit/scoring
-- como 'CMC' normal.
--
-- O NÚMERO não é mascarado (cost_price=cmc é o custo REAL; a pendência (b) do #977 segue fechada
-- — invariante cost_price=cmc, 0 violações em prod). O risco residual é só cmc-lixo (raro: ~1 SKU
-- em 3k) durante essa janela. Subir o compute para 2h encolhe a janela ~12x SEM tocar o código
-- money-path quente dos seed writers (decisão: NÃO tocar o seed agora — risco de regressão num
-- caminho de alta frequência > dano observado; a correção do seed fica como dívida de governança).
-- Roda em :45 da hora par, logo após o ciclo de seed do sync-reprocess (:15 a cada 2h).
--
-- ⚠️ APLICAÇÃO MANUAL: o Lovable NÃO auto-aplica migration de nome custom — colar no SQL Editor.
-- Idempotente: re-rodar só re-seta o MESMO schedule no MESMO job (por jobname).
-- NB: mantém o jobname 'compute-costs-daily' (histórico) para não divergir do cron_baseline/DR;
--     se o baseline for reaplicado, re-rodar este alter_job.

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'compute-costs-daily'),
  schedule := '45 */2 * * *'
);

-- Validação pós-apply (read-only) — esperado: schedule '45 */2 * * *', active true:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'compute-costs-daily';
