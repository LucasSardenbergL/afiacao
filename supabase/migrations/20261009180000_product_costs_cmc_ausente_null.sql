-- ============================================================
-- product_costs.cmc: ausente ≠ zero — fim do DEFAULT 0 + CHECK de faixa
--
-- POR QUÊ (investigação 2026-10-09): 1.416 de 3.772 linhas (~38%) tinham cmc = 0. Não era
-- custo zero: 1.412 são produtos SEM CMC no Omie, com custo ESTIMADO por proxy
-- (FAMILY_MARGIN_PROXY/DEFAULT_PROXY) em cost_final > 0; 4 são UNKNOWN sem custo algum.
-- O zero nascia no produtor (`_shared/cost-compute.ts`: `cmc: cmc ?? 0`) e na coluna
-- (`DEFAULT 0`). Todos os consumidores atuais se defendem (NULLIF(cmc,0) na v_caca_compradores;
-- cost_final > 0 via custo_canonico/finitePositive) — mas a defesa era 100% do lado do
-- consumidor: o próximo leitor de product_costs.cmc cru veria custo ZERO em ~38% do catálogo.
-- money-path §2: o par certo é consumidor E produtor.
--
-- O QUE FAZ:
--   1. DROP DEFAULT da coluna cmc (insert que omitir cmc passa a gravar NULL, não 0).
--   2. CHECK product_costs_cmc_faixa: NULL (ausente) OU finito em [0, 10.000.000].
--      ⚠️ ACEITA 0 de propósito: até o deploy do omie-analytics-sync com `cmc ?? null`, o motor
--      ainda regrava 0 a cada run. Apertar para > 0 é passo posterior, DEPOIS de medir 0 zeros.
--   SEM backfill: o computeCosts regrava TODO produto com preço a cada run; após o deploy, os
--   zeros viram NULL sozinhos no próximo ciclo (mede-se, não se presume).
--
-- Pré-voo prod (2026-10-09): 3.772 linhas, max 218.715,88, 0 violações, 2.176 kB (ADD direto,
-- scan trivial), 0 CHECKs hoje.
-- PROVADO EXECUTANDO em PG17: db/test-product-costs-cmc-faixa.sh.
-- ⚠️ MIGRATION MANUAL (nome custom não auto-aplica no Lovable).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.product_costs ALTER COLUMN cmc DROP DEFAULT;

ALTER TABLE public.product_costs DROP CONSTRAINT IF EXISTS product_costs_cmc_faixa;
ALTER TABLE public.product_costs
  ADD CONSTRAINT product_costs_cmc_faixa
  CHECK (cmc IS NULL OR (cmc >= 0 AND cmc <> 'NaN'::numeric AND cmc < 'Infinity'::numeric AND cmc <= 10000000));

COMMENT ON CONSTRAINT product_costs_cmc_faixa ON public.product_costs IS
  'cmc: NULL = sem CMC (ausente, NUNCA 0 por fabricação) ou finito em [0, 1e7]. 0 aceito só na transição do motor (cmc ?? null). Ver docs/agent/money-path.md §2.';

-- POSTCONDIÇÃO (falha alto): default removido + constraint validada
DO $post$
BEGIN
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='product_costs' AND column_name='cmc') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO_FALHOU: product_costs.cmc ainda tem DEFAULT';
  END IF;
  IF (SELECT convalidated FROM pg_constraint WHERE conname='product_costs_cmc_faixa') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICAO_FALHOU: product_costs_cmc_faixa ausente ou NOT VALID';
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK: cmc sem default e com faixa validada';
END $post$;

COMMIT;
