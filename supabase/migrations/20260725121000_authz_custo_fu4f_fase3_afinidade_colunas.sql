-- FU4-F fase 3 / PR-B — a AFINIDADE ganha coluna própria; `lie`/`lie_bundle` voltam a ser dinheiro
--
-- POR QUE EXISTE. O PR-B tirou `m_ij`/`m_bundle` de cena (invertiam para margem unitária) e, na
-- primeira versão, reaproveitou `lie`/`lie_bundle` para guardar o score de AFINIDADE
-- (adimensional, ~0,009), porque vários consumidores ORDENAM por essas colunas. Ordenar por
-- afinidade é o comportamento desejado — mas nem todo consumidor apenas ordena. Três leem o VALOR:
--
--   · src/hooks/useTacticalPlan.ts        → copia lie_bundle para `bundle_lie`
--   · .../tacticalPlan/PlanCard.tsx       → formata com { style: 'currency', currency: 'BRL' }
--                                            e divide por hora de ligação (lucro estimado/h)
--   · supabase/functions/generate-tactical-plan → injeta o valor no prompt do LLM
--
-- Com a afinidade nessas colunas, o card anunciaria "R$ 0,01" de lucro incremental esperado e
-- ~R$ 0,02/h onde os planos de produção registram R$ 1.250,50 / R$ 800. Trocar a SEMÂNTICA de uma
-- coluna sem trocar o NOME move o defeito para quem não está no diff.
--
-- ESTA MIGRATION É ADITIVA e NÃO altera dado existente: só cria as duas colunas. O scrub das
-- linhas antigas e o trigger que impede a recontaminação vivem na 20260725125000, que é aplicada
-- DEPOIS do Publish do front (a ordem está no corpo do PR #1520).
--
-- ⚠️ ORDEM DE APPLY: esta migration precisa estar aplicada ANTES do Publish do front novo — é ele
-- quem passa a gravar `affinity_score`/`affinity_bundle`. Sem as colunas, o insert do engine falha
-- com 42703 (PGRST204 no PostgREST) e as recomendações deixam de ser gravadas.
--
-- ESTADO MEDIDO EM PROD (psql-ro, 2026-08-13), antes deste apply:
--   farmer_recommendations         3.659 linhas — `lie` preenchido em 3.659, última 2026-05-12
--   farmer_bundle_recommendations     12 linhas — `lie_bundle` preenchido em 12, última 2026-03-02
--   farmer_tactical_plans            677 planos — `bundle_lie` preenchido em 0 (todos NULL)
--   nenhuma das duas tabelas tem coluna de afinidade (information_schema.columns)
-- O `bundle_lie` zerado é o que mostra o tamanho da regressão evitada: hoje o card NÃO exibe LIE
-- nenhum; com a afinidade em `lie_bundle` ele passaria a exibir R$ 0,01 como se fosse medição.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. As colunas. `numeric` (não `numeric(p,s)`): o score é uma razão sem escala fixa, e um typmod
--    apertado arredondaria silenciosamente pontuações vizinhas para o mesmo valor — empate
--    fabricado no ranking. Sem NOT NULL/DEFAULT: linha antiga tem afinidade DESCONHECIDA, e um
--    default constante seria exatamente o "rótulo com DEFAULT constante não é fato" do §5.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS affinity_score numeric;

ALTER TABLE public.farmer_bundle_recommendations
  ADD COLUMN IF NOT EXISTS affinity_bundle numeric;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. FINITUDE. `numeric` sem typmod aceita 'NaN' e 'Infinity', e em Postgres **NaN é o MAIOR
--     valor numeric** — num `ORDER BY affinity DESC` ele lidera SEMPRE. Uma única linha
--     envenenada viraria o topo permanente da oferta, e o guard "óbvio" não pega: medido em prod,
--     ('NaN' > 0) é TRUE e ('NaN' > 'Infinity') é TRUE, então `CHECK (x > 0)` aceita NaN e
--     `CHECK (x > 0 AND x <> 'NaN')` aceita Infinity. Fecham-se os TRÊS lados (money-path §2).
--     Nulável de propósito: NULL é "afinidade não medida", que é o estado de toda linha histórica.
--     Achado do challenge Codex (xhigh) nesta entrega.
--     Sem NOT VALID: as colunas acabaram de nascer, então não há passivo a validar — a varredura
--     é sobre 3.659 + 12 linhas com a coluna inteira NULL.
-- ─────────────────────────────────────────────────────────────────────────────
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
  'FU4-F fase 3: score de AFINIDADE do cross/up-sell (adimensional, ~0,009). NAO e dinheiro e NAO deriva de custo — substitui o uso de `lie` como chave de ranking. `lie` (Lucro Incremental Esperado em R$) fica NULL: invertia para margem via lie / ((p_ij/100) * complexity_factor). NULL = afinidade nao medida (linha anterior a esta coluna); quem ordena usa NULLS LAST.';

COMMENT ON COLUMN public.farmer_bundle_recommendations.affinity_bundle IS
  'FU4-F fase 3: score de AFINIDADE do bundle (adimensional). NAO e dinheiro e NAO deriva de custo — substitui o uso de `lie_bundle` como chave de ranking. `lie_bundle` fica NULL porque tres consumidores leem o VALOR (useTacticalPlan copia para bundle_lie, PlanCard formata como BRL e divide por hora, generate-tactical-plan injeta no prompt do LLM). NULL = afinidade nao medida; quem ordena usa NULLS LAST.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ASSERTS DE APLICACAO — dentro da transacao: qualquer um falha, tudo volta.
--    Leem CATALOGO, nao invocam nada (FU4-E/#1462).
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- 3.659 + 12 linhas historicas — a armadilha do gross_margin_pct (#1498).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND ((table_name='farmer_recommendations' AND column_name='affinity_score')
        OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'))
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: coluna de afinidade nasceu com DEFAULT — linha historica passaria a afirmar afinidade medida';
  END IF;

  -- A6/A7: os CHECKs de finitude existem E VALIDAM (constraint NOT VALID passaria despercebida,
  -- valendo só para escrita nova com o passivo invisível).
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conname IN ('farmer_recommendations_affinity_score_finita',
                    'farmer_bundle_recommendations_affinity_bundle_finita')
    AND contype = 'c' AND convalidated;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A6 FALHOU: esperava 2 CHECKs de finitude VALIDADOS, encontrei %', v_n;
  END IF;

  -- A7: o CHECK precisa REALMENTE recusar NaN. Provar EXECUTANDO — `NaN > 0` e `NaN > Infinity`
  -- sao TRUE em numeric, entao um CHECK mal escrito se le como protecao e deixa passar.
  BEGIN
    INSERT INTO public.farmer_bundle_recommendations (bundle_products, affinity_bundle)
    VALUES ('[]'::jsonb, 'NaN'::numeric);
    RAISE EXCEPTION 'A7 FALHOU: o CHECK aceitou affinity_bundle = NaN (lideraria todo ORDER BY DESC)';
  EXCEPTION
    WHEN check_violation THEN NULL;  -- 23514: exatamente o esperado
  END;

  RAISE NOTICE 'FU4-F fase 3: affinity_score/affinity_bundle criadas (numeric, sem default, finitas)';
END
$post$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDACAO POS-APPLY (read-only; esperado: 2 linhas, ambas numeric e sem default)
--
--   SELECT table_name, column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public'
--     AND ((table_name='farmer_recommendations'        AND column_name='affinity_score')
--       OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'));
-- ─────────────────────────────────────────────────────────────────────────────
