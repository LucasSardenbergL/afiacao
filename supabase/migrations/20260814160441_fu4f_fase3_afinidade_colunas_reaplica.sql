-- ============================================================================================
-- FU4-F fase 3 — REAPLICA as colunas de afinidade que a 20260725121000 não conseguiu criar.
--
-- POR QUE EXISTE (não é duplicata):
-- A 20260725121000 abortou no primeiro apply em prod (2026-08-14, SQL Editor) com
--   ERROR: 23502: null value in column "farmer_id" ... violates not-null constraint
-- O autoteste A7 dela prova, EXECUTANDO, que o CHECK de finitude recusa NaN — mas o INSERT de
-- prova omitia `farmer_id` e `customer_user_id`, que são NOT NULL sem default. O INSERT então
-- morria em not_null_violation (23502) ANTES de alcançar o CHECK, e o handler só capturava
-- check_violation (23514) — o 23502 escapou e derrubou a transação inteira. Conferido por
-- psql-ro logo depois: 0 de 2 colunas criadas, rollback limpo, sem estado parcial.
--
-- Migration committed é imutável (o snapshot é fonte de DR e o apply é manual), então a correção
-- entra como migration NOVA em vez de edição da anterior.
--
-- Tudo aqui é idempotente: se a 20260725121000 for reaplicada um dia (corrigida) ou se esta rodar
-- duas vezes, nada quebra e nada é duplicado.
--
-- Colar no SQL Editor do Lovable (Lovable não aplica migrations de nome custom automaticamente).
-- ============================================================================================

BEGIN;

-- ─────────────────────────────────────────────────
-- 1. As colunas. `numeric` (não `numeric(p,s)`): o score é uma razão sem escala fixa, e um typmod
--    apertado arredondaria pontuações vizinhas para o mesmo valor — empate fabricado no ranking.
--    Sem NOT NULL/DEFAULT: linha antiga tem afinidade DESCONHECIDA, e um default constante seria
--    "rótulo com DEFAULT constante não é fato" (a armadilha do gross_margin_pct, #1498).
-- ─────────────────────────────────────────────────
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS affinity_score numeric;

ALTER TABLE public.farmer_bundle_recommendations
  ADD COLUMN IF NOT EXISTS affinity_bundle numeric;

-- ─────────────────────────────────────────────────
-- 1b. FINITUDE. `numeric` sem typmod aceita 'NaN' e 'Infinity', e em Postgres NaN é o MAIOR valor
--     numeric — num `ORDER BY affinity DESC` ele lidera SEMPRE. Uma linha envenenada viraria o
--     topo permanente da oferta, e o guard "óbvio" não pega: ('NaN' > 0) é TRUE e
--     ('NaN' > 'Infinity') é TRUE, então `CHECK (x > 0)` aceita NaN e `CHECK (x > 0 AND x <> 'NaN')`
--     aceita Infinity. Fecham-se os TRÊS lados. Nulável de propósito: NULL é "não medida".
-- ─────────────────────────────────────────────────
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_recommendations_affinity_score_finita') THEN
    ALTER TABLE public.farmer_recommendations
      ADD CONSTRAINT farmer_recommendations_affinity_score_finita
      CHECK (affinity_score IS NULL
             OR (affinity_score <> 'NaN'::numeric
                 AND affinity_score < 'Infinity'::numeric
                 AND affinity_score >= 0));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_bundle_recommendations_affinity_bundle_finita') THEN
    ALTER TABLE public.farmer_bundle_recommendations
      ADD CONSTRAINT farmer_bundle_recommendations_affinity_bundle_finita
      CHECK (affinity_bundle IS NULL
             OR (affinity_bundle <> 'NaN'::numeric
                 AND affinity_bundle < 'Infinity'::numeric
                 AND affinity_bundle >= 0));
  END IF;
END
$chk$;

COMMENT ON COLUMN public.farmer_recommendations.affinity_score IS
  'FU4-F fase 3: score de AFINIDADE do cross/up-sell (adimensional, ~0,009). NAO e dinheiro e NAO deriva de custo — substitui o uso de `lie` como chave de ranking. Nunca formatar como R$.';

COMMENT ON COLUMN public.farmer_bundle_recommendations.affinity_bundle IS
  'FU4-F fase 3: score de AFINIDADE do bundle (adimensional). NAO e dinheiro e NAO deriva de custo — substitui o uso de `lie_bundle` como chave de ranking. Nunca formatar como R$.';

-- ─────────────────────────────────────────────────
-- 2. ASSERTS DE APLICACAO — dentro da transacao: qualquer um falha, tudo volta.
--    Leem CATALOGO; a única exceção é o A7, que precisa provar EXECUTANDO.
-- ─────────────────────────────────────────────────
DO $post$
DECLARE
  v_tipo text;
  v_n    int;
BEGIN
  SELECT data_type INTO v_tipo FROM information_schema.columns
  WHERE table_schema='public' AND table_name='farmer_recommendations' AND column_name='affinity_score';
  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: farmer_recommendations.affinity_score nao existe apos o ALTER';
  END IF;
  IF v_tipo <> 'numeric' THEN
    RAISE EXCEPTION 'A2 FALHOU: farmer_recommendations.affinity_score e % (esperado numeric)', v_tipo;
  END IF;

  SELECT data_type INTO v_tipo FROM information_schema.columns
  WHERE table_schema='public' AND table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle';
  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'A3 FALHOU: farmer_bundle_recommendations.affinity_bundle nao existe apos o ALTER';
  END IF;
  IF v_tipo <> 'numeric' THEN
    RAISE EXCEPTION 'A4 FALHOU: farmer_bundle_recommendations.affinity_bundle e % (esperado numeric)', v_tipo;
  END IF;

  -- A coluna NAO pode nascer com default: default constante viraria "afinidade 0 medida" para
  -- as linhas historicas.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND ((table_name='farmer_recommendations' AND column_name='affinity_score')
        OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'))
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: coluna de afinidade nasceu com DEFAULT — linha historica passaria a afirmar afinidade medida';
  END IF;

  -- A6: os CHECKs de finitude existem E VALIDAM (constraint NOT VALID passaria despercebida,
  -- valendo só para escrita nova com o passivo invisível).
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conname IN ('farmer_recommendations_affinity_score_finita',
                    'farmer_bundle_recommendations_affinity_bundle_finita')
    AND contype = 'c' AND convalidated;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A6 FALHOU: esperava 2 CHECKs de finitude VALIDADOS, encontrei %', v_n;
  END IF;

  -- A7: o CHECK precisa REALMENTE recusar NaN. Provar EXECUTANDO — `NaN > 0` e `NaN > 'Infinity'`
  -- sao TRUE em numeric, entao um CHECK mal escrito se le como protecao e deixa passar.
  --
  -- ⚠️ AQUI ESTAVA O BUG QUE ABORTOU A 20260725121000. As colunas NOT NULL sem default
  -- (farmer_id, customer_user_id) entram EXPLICITAMENTE: sem elas o INSERT morre em
  -- not_null_violation (23502) ANTES de alcançar o CHECK e, como o handler abaixo captura apenas
  -- check_violation, o 23502 escapa e derruba a migration inteira.
  --
  -- Os uuid sao sinteticos e a tabela nao tem FK alguma (conferido por psql-ro em prod), entao nao
  -- ha linha real a referenciar. A linha nunca chega a existir: o CHECK a recusa, que e o ponto.
  -- Se um dia surgir OUTRA coluna NOT NULL, este assert volta a falhar ALTO — que e o correto.
  -- Capturar `WHEN OTHERS` para "consertar" isso transformaria a prova em teatro: passaria a
  -- engolir justamente o erro que revelou o defeito.
  BEGIN
    INSERT INTO public.farmer_bundle_recommendations
      (farmer_id, customer_user_id, bundle_products, affinity_bundle)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 'NaN'::numeric);
    RAISE EXCEPTION 'A7 FALHOU: o CHECK aceitou affinity_bundle = NaN (lideraria todo ORDER BY DESC)';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- 23514: exatamente o esperado
  END;

  -- A8: o mesmo para farmer_recommendations — a 20260725121000 so provava o lado do bundle, e as
  -- duas constraints sao independentes (uma pode estar certa e a outra nao).
  --
  -- Esta tabela NAO e simetrica a de bundle e o INSERT tem de respeitar isso (medido por psql-ro):
  --   · NOT NULL sem default: farmer_id, customer_user_id, recommendation_type (3, nao 2);
  --   · recommendation_type tem CHECK ANY(ARRAY['cross_sell','up_sell']) — texto arbitrario
  --     dispararia check_violation pelo motivo ERRADO e o assert passaria por acidente;
  --   · 2 FKs para omie_products(id): product_id e current_product_id. Ambas ficam de FORA do
  --     INSERT de proposito — sao NULLABLE, e NULL nao e checado por FK.
  --
  -- Sobre as FKs, o registro honesto (medido no PG17 do harness, porque eu supus errado antes de
  -- testar): preenche-las com uuid sintetico NAO derrubaria este bloco hoje. CHECK e avaliado
  -- durante o INSERT e FK dispara como constraint trigger DEPOIS, entao o check_violation morde
  -- primeiro e o handler o captura — a FK nunca chega a ser alcancada. Omiti-las nao e, portanto,
  -- correcao de um erro atual; e nao DEPENDER dessa ordem: no dia em que o CHECK for afrouxado
  -- (exatamente o que o assert existe para detectar), a FK passaria a disparar 23503 e derrubaria
  -- a migration pelo motivo errado, escondendo o defeito real atras de um erro de referencia.
  BEGIN
    INSERT INTO public.farmer_recommendations
      (farmer_id, customer_user_id, recommendation_type, affinity_score)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'cross_sell', 'NaN'::numeric);
    RAISE EXCEPTION 'A8 FALHOU: o CHECK aceitou affinity_score = NaN';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- 23514: esperado
  END;

  RAISE NOTICE 'FU4-F fase 3: affinity_score/affinity_bundle criadas (numeric, sem default, finitas)';
END
$post$;

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- VALIDACAO POS-APPLY (read-only; esperado: 2 linhas, ambas numeric e sem default)
--
--   SELECT table_name, column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public'
--     AND ((table_name='farmer_recommendations'        AND column_name='affinity_score')
--       OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'));
-- ────────────────────────────────────────────────────────────────────────────────────────────
