-- ============================================================
-- backfill_kb_documents_product_code
--   Preenche kb_documents.product_code (hoje VAZIO em 100% dos documentos) a partir da ficha
--   aprovada (kb_product_specs), via o vínculo real spec.document_id = documento.id.
--
-- Por quê: a tela AdminKnowledgeBaseDetail liga documento→ficha por useKbProductSpecs(data.product_code),
--   com enabled:!!productCode. Como product_code nasce NULL no upload/extração e nunca é carimbado de
--   volta no documento, a query fica desligada → os 3 painéis (Specs, vínculo base, Catalisador) têm
--   condição existingSpecs?.approved_at e NÃO renderizam. O vínculo correto (document_id) está íntegro;
--   este backfill é a ponte até o conserto de raiz (a tela passar a achar a ficha por document_id).
--
-- Idempotente: só toca linhas ainda vazias (WHERE product_code vazio); re-rodar não re-escreve nada.
-- Seguro (diagnóstico read-only 2026-07-01): 119 fichas aprovadas · 1 ficha por documento (0 com N) ·
--   product_code único (0 repetido) e não-nulo (0 vazio) → preenchimento 1:1 sem ambiguidade.
-- Não toca money-path: product_code é identidade de produto, não preço/estoque/gate.
-- ============================================================

UPDATE public.kb_documents AS d
SET product_code = s.product_code,
    updated_at   = now()
FROM public.kb_product_specs AS s
WHERE s.document_id = d.id
  AND s.approved_at IS NOT NULL
  AND s.product_code IS NOT NULL
  AND btrim(s.product_code) <> ''
  AND (d.product_code IS NULL OR btrim(d.product_code) = '');
