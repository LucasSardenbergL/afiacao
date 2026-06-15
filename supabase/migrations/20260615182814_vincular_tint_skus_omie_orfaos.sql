-- ============================================================
-- Vincular tint_skus órfãos (account 'oben') a produtos Omie já cadastrados e ATIVOS
-- Objetivo: resgatar cores tintométricas que somem do seletor de venda porque
--   TODOS os SKUs da cor estão sem omie_product_id. O SKU é compartilhado por
--   muitas cores (base+embalagem+acabamento, sem cor), então vincular 1 SKU
--   devolve dezenas de cores ao balcão de uma vez.
--
-- 4 vínculos inequívocos (código-base Sayer + sigla de embalagem EXATOS,
--   produto Omie ATIVO com valor_unitario>0). Os 2 primeiros resgatam ~62 cores
--   que hoje não têm nenhuma embalagem vendável:
--     WJOB.7658 QT  -> PRD02806  (~54 cores ACR MAX da base WJOB.7658)
--     WFOB.6564 GL  -> PRD01919  (~8 cores da base WFOB.6564)
--   Os outros 2 são vínculos corretos que acrescentam embalagem a cores que já
--   vendem em outra embalagem (não resgatam "some", mas completam a cobertura):
--     WJOB.7796 GL  -> PRD03644
--     WJOB.7585 405ML -> PRD02836
--
-- IDEMPOTENTE: só toca SKU ainda NULL (re-rodar = UPDATE 0).
-- FALHA-FECHADA: o EXISTS exige que o produto-alvo seja 'oben' e ATIVO — se o ID
--   estiver errado ou o produto tiver sido desativado, o vínculo NÃO acontece
--   (o SKU segue NULL e a validação pós-apply mostra), nunca grava lixo.
-- Money-path: ver CLAUDE.md §5 (ausente ≠ zero; 1 writer autoritativo por sinal).
-- ============================================================

UPDATE public.tint_skus AS s
SET omie_product_id = v.omie_id,
    updated_at = now()
FROM (VALUES
  ('ca5c68b0-42c0-42fc-8409-ef1ee3fd770d'::uuid, '8b83da0e-ba3c-4ad7-bb3c-3ffb12d2252c'::uuid), -- WJOB.7658 QT  -> PRD02806
  ('52bffc48-ce34-4bca-9a8d-83c12993bebd'::uuid, '423ecfc4-0e2a-4659-b7ff-96cbd1213745'::uuid), -- WFOB.6564 GL  -> PRD01919
  ('7a1db16a-8b9c-4f02-bdec-214c8d625e55'::uuid, 'f639e6d0-9d6f-4dc9-bea8-391c0c5d7370'::uuid), -- WJOB.7796 GL  -> PRD03644
  ('fb6cb6c7-1ccc-40f2-8b41-7eea7e1c55bc'::uuid, '3a6c47c0-266c-42f2-82ec-187e999fbc50'::uuid)  -- WJOB.7585 405 -> PRD02836
) AS v(sku_id, omie_id)
WHERE s.id = v.sku_id
  AND s.account = 'oben'
  AND s.omie_product_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.omie_products op
    WHERE op.id = v.omie_id
      AND op.account = 'oben'
      AND op.ativo = true
  );
