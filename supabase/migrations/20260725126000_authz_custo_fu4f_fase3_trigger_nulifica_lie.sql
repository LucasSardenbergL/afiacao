-- FU4-F fase 3 / PR-B — o trigger anti-recontaminação passa a nulificar `lie`/`lie_bundle`
--
-- FECHA O RESÍDUO QUE A 20260725125000 DECLAROU. Lá o trigger deixa `lie`/`lie_bundle` intactos de
-- propósito, com esta justificativa textual: "no desenho novo essas colunas guardam o score de
-- AFINIDADE (adimensional, legítimo) e nulificá-las mataria o ranking". A premissa caiu — a
-- afinidade ganhou coluna própria em 20260725121000 (`affinity_score` / `affinity_bundle`), porque
-- três consumidores fora do diff liam `lie_bundle` como DINHEIRO (PlanCard formata em BRL, o
-- lucro/hora divide por tempo de ligação, a edge injeta no prompt do LLM).
--
-- Com o ranking mudado de casa, `lie`/`lie_bundle` voltam a significar só "Lucro Incremental
-- Esperado em R$" — e esse número INVERTE para margem unitária:
--     m_ij     ≈ lie        / ((p_ij    / 100) × complexity_factor)
--     m_bundle ≈ lie_bundle / ((p_bundle/ 100) × complexity_factor)
-- O `p_ij`/`p_bundle` e o `complexity_factor` continuam na tabela e são legítimos (probabilidade e
-- fator de esforço, não custo). Quem fecha a inversão é a ausência do numerador.
--
-- O QUE ISTO IMPEDE, na prática: o resíduo que a 125000 assume é uma aba ANTIGA (bundle JS
-- pré-Publish, ainda carregada no browser de alguém) gravando `lie` monetário em linha FRESCA
-- depois do scrub. A janela é curta, mas ela existe justamente quando mais dói — logo após o
-- Publish, com o operador ainda trabalhando. Nulificar sempre a elimina.
--
-- MIGRATION SEPARADA (e não edição da 125000) porque migration committada é imutável neste repo:
-- o snapshot é a fonte de DR e o apply é manual. Esta roda DEPOIS da 125000 e a supersede no que
-- toca aos triggers; `CREATE OR REPLACE` sobre as mesmas duas funções, mesmos dois triggers.
--
-- PRÉ-VOO PROD (psql-ro, 2026-08-13): `private.frec_sem_margem` e `private.fbrec_sem_margem` NÃO
-- existem, e as duas tabelas têm ZERO triggers não-internos — nada a preservar de um apply manual
-- divergente. A 125000 ainda não foi colada.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDIÇÕES — fail-closed. A ordem de apply manual passa a ser garantida pelo banco.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  -- 1. Sem as colunas de afinidade, nulificar `lie`/`lie_bundle` tira a chave de ranking de
  --    cross-sell e bundles SEM substituto: a lista sai na ordem de inserção, em silêncio.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='farmer_recommendations' AND column_name='affinity_score'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'
  ) THEN
    RAISE EXCEPTION
      'precondicao FALHOU: affinity_score/affinity_bundle ausentes. Aplique 20260725121000 ANTES — sem elas, nulificar lie/lie_bundle deixa cross-sell e bundles sem chave de ranking.';
  END IF;

  -- 2. Esta migration SUBSTITUI as funções criadas pela 20260725125000. Se ela não foi aplicada,
  --    aplicar esta sozinha deixaria `m_ij`/`m_bundle` e o custo LITERAL no jsonb sem scrub e sem
  --    guarda — o inverso do que o conjunto promete.
  IF to_regprocedure('private.fbrec_sem_margem()') IS NULL
     OR to_regprocedure('private.frec_sem_margem()') IS NULL THEN
    RAISE EXCEPTION
      'precondicao FALHOU: private.frec_sem_margem/fbrec_sem_margem ausentes. Aplique 20260725125000 ANTES — ela e quem faz o scrub do historico e cria a guarda que esta migration endurece.';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Re-scrub idempotente. A 125000 já nulificou o histórico; isto cobre a JANELA entre as duas
--    colagens no SQL Editor (o founder aplica uma de cada vez) e torna esta migration segura de
--    re-colar. Sem trigger nas tabelas que avance `updated_at`, o frescor que o Sentinela observa
--    não é falsificado (conferido em prod: 0 triggers não-internos).
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.farmer_recommendations
SET lie = NULL
WHERE lie IS NOT NULL;

UPDATE public.farmer_bundle_recommendations
SET lie_bundle = NULL
WHERE lie_bundle IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. As guardas, agora nulificando o LIE também.
--
--    Continua NULIFICANDO em vez de REJEITAR: rejeitar quebraria o insert do frontend velho com
--    erro visível ao usuário; nulificar deixa a feature funcionar degradada e garante a
--    invariante. E o writer NOVO não é afetado — ele já manda `lie`/`lie_bundle` NULL.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.frec_sem_margem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $fn$
BEGIN
  NEW.m_ij := NULL;
  -- `lie` é DINHEIRO: inverte para margem unitária junto com p_ij + complexity_factor.
  -- A afinidade que ordena a lista vive em `affinity_score`, que o trigger NÃO toca.
  NEW.lie := NULL;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION private.frec_sem_margem() IS
  'FU4-F fase 3: impede que a margem absoluta (m_ij) e o lucro incremental em R$ (lie) voltem a farmer_recommendations por um writer antigo em aba nao recarregada. Os dois invertem para margem unitaria. NAO toca affinity_score, que e o ranking. Nulifica em vez de rejeitar para nao quebrar tela.';

CREATE OR REPLACE FUNCTION private.fbrec_sem_margem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $fn$
BEGIN
  NEW.m_bundle := NULL;
  -- idem `lie_bundle`: m_bundle ≈ lie_bundle / ((p_bundle/100) × complexity_factor).
  -- `affinity_bundle` fica intacto — é adimensional e é o que ordena a oferta.
  NEW.lie_bundle := NULL;
  IF jsonb_typeof(NEW.bundle_products) = 'array' THEN
    NEW.bundle_products := (
      SELECT COALESCE(jsonb_agg(
               CASE WHEN jsonb_typeof(elem) = 'object' THEN elem - 'cost' - 'margin' ELSE elem END
               ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(NEW.bundle_products) WITH ORDINALITY AS t(elem, ord)
    );
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION private.fbrec_sem_margem() IS
  'FU4-F fase 3: impede que margem/custo por SKU (m_bundle, cost/margin no jsonb) e o lucro incremental em R$ (lie_bundle) voltem a farmer_bundle_recommendations por um writer antigo. NAO toca affinity_bundle, que e o ranking. Nulifica em vez de rejeitar para nao quebrar tela.';

-- Os triggers já existem (20260725125000) e apontam para estas funções por NOME, então o REPLACE
-- acima já muda o comportamento. Recriados assim mesmo: se a 125000 for re-colada DEPOIS desta
-- (apply manual não tem ordem garantida), o DROP+CREATE de lá não perde nada — e aqui a
-- recriação torna esta migration auto-suficiente sobre um banco em que só as funções existam.
DROP TRIGGER IF EXISTS trg_frec_sem_margem ON public.farmer_recommendations;
CREATE TRIGGER trg_frec_sem_margem
  BEFORE INSERT OR UPDATE ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.frec_sem_margem();

DROP TRIGGER IF EXISTS trg_fbrec_sem_margem ON public.farmer_bundle_recommendations;
CREATE TRIGGER trg_fbrec_sem_margem
  BEFORE INSERT OR UPDATE ON public.farmer_bundle_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.fbrec_sem_margem();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ASSERTS DE APLICACAO — dentro da transacao. Leem CATALOGO (pg_get_functiondef), nao invocam.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src text;
  v_n   int;
BEGIN
  v_src := pg_get_functiondef(to_regprocedure('private.frec_sem_margem()'));
  IF v_src NOT LIKE '%NEW.lie := NULL%' THEN
    RAISE EXCEPTION 'A1 FALHOU: frec_sem_margem nao nulifica lie — o REPLACE nao pegou';
  END IF;
  IF v_src NOT LIKE '%NEW.m_ij := NULL%' THEN
    RAISE EXCEPTION 'A2 FALHOU: frec_sem_margem perdeu a nulificacao de m_ij';
  END IF;
  IF v_src LIKE '%affinity_score :=%' THEN
    RAISE EXCEPTION 'A3 FALHOU: frec_sem_margem mexe em affinity_score — o ranking morreria';
  END IF;

  v_src := pg_get_functiondef(to_regprocedure('private.fbrec_sem_margem()'));
  IF v_src NOT LIKE '%NEW.lie_bundle := NULL%' THEN
    RAISE EXCEPTION 'A4 FALHOU: fbrec_sem_margem nao nulifica lie_bundle — o REPLACE nao pegou';
  END IF;
  IF v_src NOT LIKE '%NEW.m_bundle := NULL%' THEN
    RAISE EXCEPTION 'A5 FALHOU: fbrec_sem_margem perdeu a nulificacao de m_bundle';
  END IF;
  IF v_src NOT LIKE '%- ''cost'' - ''margin''%' THEN
    RAISE EXCEPTION 'A6 FALHOU: fbrec_sem_margem perdeu a limpeza de cost/margin do jsonb';
  END IF;
  IF v_src LIKE '%affinity_bundle :=%' THEN
    RAISE EXCEPTION 'A7 FALHOU: fbrec_sem_margem mexe em affinity_bundle — o ranking morreria';
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN ('trg_frec_sem_margem','trg_fbrec_sem_margem');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A8 FALHOU: esperava 2 triggers de guarda, encontrei %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.farmer_recommendations WHERE lie IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'A9 FALHOU: % linha(s) de farmer_recommendations ainda com lie monetario', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.farmer_bundle_recommendations WHERE lie_bundle IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'A10 FALHOU: % linha(s) de farmer_bundle_recommendations ainda com lie_bundle monetario', v_n;
  END IF;

  RAISE NOTICE 'FU4-F fase 3: guardas endurecidas — lie/lie_bundle nulificados sempre; afinidade intacta';
END
$post$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDACAO POS-APPLY (read-only; esperado: tudo zero / true)
--
--   SELECT count(*) FILTER (WHERE lie IS NOT NULL) AS lie_restante FROM public.farmer_recommendations;
--   SELECT count(*) FILTER (WHERE lie_bundle IS NOT NULL) AS liebundle_restante
--     FROM public.farmer_bundle_recommendations;
--
--   SELECT p.proname,
--          pg_get_functiondef(p.oid) LIKE '%NEW.lie%:= NULL%' AS nulifica_lie
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='private' AND p.proname IN ('frec_sem_margem','fbrec_sem_margem');
-- ─────────────────────────────────────────────────────────────────────────────
