-- supabase/migrations/20260716230000_sku_leadtime_proveniencia.sql
-- Proveniência do leadtime por item: de QUAL recebimento veio cada linha.
--
-- Por quê: uma chave de NFe pode cobrir vários pedidos. Com o item atribuído ao pedido
-- dele, a unicidade (tracking_id, sku_codigo_omie) passaria a significar "um leadtime por
-- (pedido, SKU)" — e ENTREGAS PARCIAIS (mesmo SKU do mesmo pedido chegando em NFes
-- distintas) colidiriam: a segunda entrega sobrescreveria a primeira, SILENCIOSAMENTE.
-- Duplicata infla; perda apaga. Daí a proveniência entrar na chave.
--
-- NULLS NOT DISTINCT (PG15+; prod é 17.6): linhas históricas ficam com nid_receb NULL e
-- precisam continuar deduplicando ENTRE SI como antes. Com o default (NULLS DISTINCT),
-- duas linhas (tracking, sku, NULL) coexistiriam e a duplicata voltaria pela porta dos
-- fundos.
--
-- ⚠️ ORDEM: esta migration roda DEPOIS da limpeza do histórico. Antes dela, a constraint
-- nova é violada pelas duplicatas existentes e o ALTER falha.

ALTER TABLE public.sku_leadtime_history
  ADD COLUMN IF NOT EXISTS nid_receb bigint;

COMMENT ON COLUMN public.sku_leadtime_history.nid_receb IS
  'Recebimento (Omie nIdReceb) que originou esta linha. Proveniência + parte da unicidade: '
  'permite que entregas parciais do mesmo (pedido, SKU) coexistam. NULL = linha anterior à '
  'proveniência.';

ALTER TABLE public.sku_leadtime_history
  DROP CONSTRAINT IF EXISTS uq_sku_hist_tracking_sku;

ALTER TABLE public.sku_leadtime_history
  DROP CONSTRAINT IF EXISTS uq_sku_hist_tracking_sku_receb;

ALTER TABLE public.sku_leadtime_history
  ADD CONSTRAINT uq_sku_hist_tracking_sku_receb
  UNIQUE NULLS NOT DISTINCT (tracking_id, sku_codigo_omie, nid_receb);
