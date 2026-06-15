-- ============================================================
-- tint_remapeia_skus_omie_desalinhadas
-- Conserta 4 SKUs de tintometria (account='oben') cujo omie_product_id ficou
-- desalinhado no seed em lote de 2026-03-23 (casaram o produto Omie errado por
-- base/embalagem). Resolve os 3 pares ambíguos do vigia `tint_vinculo_omie`
-- (Sentinela / Saúde de Dados) — cada produto Omie tinha 2 SKUs ativas
-- apontando pra ele — e de bônus conserta a single mal-vinculada PRD01926.
--
-- Todas as 4 SKUs têm venda 0 (tint_vendas_itens) → conserto não-destrutivo.
-- Prova (dry-run via simulação read-only): 0 pares ambíguos pós-remapeamento.
--
-- De-para (SKU → produto Omie correto, casado por base + embalagem):
--   05f0fb79  base WFOI.6736 INTER / QT  : PRD02224 (WFOB total) → PRD02187 (INTER WFOI.6736QT)
--   f2e39d17  base WFOT.6501 TRANSP / GL : PRD02378 (QT)         → PRD02364 (WFOT.6501GL)
--   b850b1d9  base WFOT.6529 TRANSP / GL : PRD01926 (WFOI)       → PRD03657 (WFOT.6529GL)  [libera PRD01926]
--   8d4493f5  base WFOI.6529 INTER / GL  : PRD01899 (QT)         → PRD01926 (WFOI.6529GL)
--
-- Idempotente: a guarda `IS DISTINCT FROM` torna a re-execução um no-op.
-- Fail-safe: o JOIN em omie_products por (id + codigo esperado + account)
-- só permite o UPDATE se o UUID de destino corresponder ao código esperado —
-- se algum UUID estiver errado, aquele UPDATE simplesmente não ocorre (jamais
-- seta omie_product_id = NULL). Obs.: o código PRD03657 também existe na conta
-- colacor (uma "CINTA ATX170") — outro registro/empresa do grupo; dentro de oben
-- o código é único, e o filtro account='oben' já isola o produto base correto.
-- ============================================================

WITH remap(sku_id, novo_omie_id, codigo_esperado) AS (
  VALUES
    ('05f0fb79-c5c4-434a-8f8c-bc5593f9dd4a'::uuid, 'c5e1c71d-634b-404d-86af-e528e9d8d19e'::uuid, 'PRD02187'),
    ('f2e39d17-6035-4679-92d8-8a3fa030accd'::uuid, '1aee5629-8a99-426c-bb9c-bf808ec86352'::uuid, 'PRD02364'),
    ('b850b1d9-9464-4ff8-b80b-937bccd4a5aa'::uuid, '81835f3c-e9f7-48d8-aa7e-94bb372f7f93'::uuid, 'PRD03657'),
    ('8d4493f5-2bed-4793-8a64-8c33a7ce5b1b'::uuid, 'eb7e2fb7-3a77-4331-addc-e7f24bcb7cec'::uuid, 'PRD01926')
)
UPDATE public.tint_skus ts
SET omie_product_id = r.novo_omie_id,
    updated_at      = now()
FROM remap r
JOIN public.omie_products op
  ON op.id      = r.novo_omie_id
 AND op.codigo  = r.codigo_esperado
 AND op.account = 'oben'
WHERE ts.id = r.sku_id
  AND ts.account = 'oben'
  AND ts.omie_product_id IS DISTINCT FROM r.novo_omie_id;
