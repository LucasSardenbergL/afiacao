-- cost_price nullable — "ausente" (sem custo real) passa a ser NULL em vez de 0.
--
-- Parte da correção da LAVAGEM DE PROVENIÊNCIA de custo (cost_source). O motor de custo
-- (omie-analytics-sync/computeCosts) deixa de semear proxy em cost_price; quando não há
-- custo real (CMC), grava NULL. A constraint NOT NULL DEFAULT 0 bloqueava isso (forçava 0,
-- que os consumidores money-path liam como custo 0 → margem 100% — ausente≠zero).
--
-- ⚠️ APLICAÇÃO MANUAL (Lovable não auto-aplica migration de nome custom).
-- ⚠️ ORDEM: esta migration tem de ser aplicada ANTES do deploy do edge corrigido — senão o
--    edge novo tenta gravar cost_price=NULL sob a constraint NOT NULL e o upsert falha.
-- Idempotente: DROP NOT NULL / DROP DEFAULT são no-op se já aplicados.

ALTER TABLE public.product_costs ALTER COLUMN cost_price DROP NOT NULL;
ALTER TABLE public.product_costs ALTER COLUMN cost_price DROP DEFAULT;

-- Validação pós-apply (read-only) — esperado: is_nullable='YES', column_default IS NULL:
--   SELECT is_nullable, column_default FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='product_costs' AND column_name='cost_price';
