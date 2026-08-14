-- FU4-F fase 3 / PR-B — colunas de AFINIDADE (v2). SUBSTITUI a 20260725121000, que ABORTA.
--
-- ⚠️ NÃO COLE A 20260725121000 — ela falha SEMPRE, em qualquer banco com o schema real. Esta
-- migration faz tudo o que ela faria; a outra ficou no histórico porque migration committada é
-- imutável neste repo (o snapshot, não o replay, é a fonte de DR). Se alguém colá-la por engano,
-- o efeito é um erro visível e rollback total — sem dano, porque os `IF NOT EXISTS` daqui já
-- terão criado tudo e o rollback dela não remove o que esta transação commitou.
--
-- POR QUE A 121000 ABORTA (medido em prod 2026-08-14, na tentativa de apply):
--   ERROR 23502: null value in column "farmer_id" of relation "farmer_bundle_recommendations"
-- O assert A7 dela provava o CHECK de finitude com um INSERT de `affinity_bundle = 'NaN'`,
-- passando só duas colunas. Só que as duas tabelas têm NOT NULL **sem default** em
-- `farmer_id` e `customer_user_id` (mais `recommendation_type` em farmer_recommendations), então
-- o INSERT morre por 23502 ANTES de o CHECK ser exercido — e 23502 não é `check_violation`, então
-- escapa do handler, propaga e derruba a migration inteira. Fail-closed correto: NADA foi
-- aplicado (conferido depois por psql-ro: zero colunas, zero constraints).
--
-- POR QUE O HARNESS LOCAL NÃO PEGOU (a lição que fica): o `db/test-authz-custo-fu4f-fase3-scrub.sh`
-- monta as tabelas por STUB — `CREATE TABLE` só com as colunas que a migration toca — e o stub
-- não tinha os NOT NULL da tabela real. Um assert que ESCREVE só é tão fiel quanto o stub: ele
-- exercita o schema, não só a lógica. O stub foi corrigido na mesma entrega, e o pré-voo de PROD
-- passa a conferir CONSTRAINTS, não só a existência das colunas.
--
-- O CONSERTO: provar o CHECK por UPDATE de uma linha EXISTENTE, não por INSERT. Não depende de
-- coluna obrigatória nenhuma — e continua imune a colunas NOT NULL que venham a ser criadas
-- depois, que é o que tornaria o INSERT frágil para sempre.

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
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_tipo text;
  v_n    int;
  v_id   uuid;
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

  -- A5: a coluna NAO pode nascer com default — default constante viraria "afinidade 0 medida"
  -- para 3.659 + 12 linhas historicas (a armadilha do gross_margin_pct, #1498).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND ((table_name='farmer_recommendations' AND column_name='affinity_score')
        OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'))
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: coluna de afinidade nasceu com DEFAULT — linha historica passaria a afirmar afinidade medida';
  END IF;

  -- A6: os CHECKs existem E estao VALIDADOS. Constraint NOT VALID passaria despercebida,
  -- valendo so para escrita nova, com o passivo invisivel.
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conname IN ('farmer_recommendations_affinity_score_finita',
                    'farmer_bundle_recommendations_affinity_bundle_finita')
    AND contype = 'c' AND convalidated;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A6 FALHOU: esperava 2 CHECKs de finitude VALIDADOS, encontrei %', v_n;
  END IF;

  -- A7: o CHECK precisa REALMENTE recusar NaN. Ler o TEXTO da constraint nao serve: `CHECK (x>0)`
  -- se le como protecao e aceita NaN (medido em prod: 'NaN' > 0 e TRUE). So executando se sabe.
  --
  -- UPDATE de linha existente, nao INSERT: a v1 desta migration morreu aqui com 23502 porque as
  -- duas tabelas tem NOT NULL sem default em farmer_id/customer_user_id, e um INSERT minimo nao
  -- os preenche. O UPDATE nao depende de coluna obrigatoria nenhuma — nem das que vierem depois.
  SELECT id INTO v_id FROM public.farmer_bundle_recommendations LIMIT 1;
  IF v_id IS NOT NULL THEN
    BEGIN
      UPDATE public.farmer_bundle_recommendations SET affinity_bundle = 'NaN'::numeric WHERE id = v_id;
      RAISE EXCEPTION 'A7 FALHOU: o CHECK aceitou affinity_bundle = NaN (lideraria todo ORDER BY DESC)';
    EXCEPTION
      WHEN check_violation THEN NULL;  -- 23514: exatamente o esperado, e a subtransacao desfaz o UPDATE
    END;

    BEGIN
      UPDATE public.farmer_bundle_recommendations SET affinity_bundle = 'Infinity'::numeric WHERE id = v_id;
      RAISE EXCEPTION 'A8 FALHOU: o CHECK aceitou affinity_bundle = Infinity';
    EXCEPTION
      WHEN check_violation THEN NULL;
    END;

    -- Controle POSITIVO: sem ele, um CHECK que recusasse TUDO passaria em A7/A8 e mataria a
    -- gravacao do motor — trocar o veneno por uma coluna inutilizavel tambem e falha.
    UPDATE public.farmer_bundle_recommendations SET affinity_bundle = 0.0094 WHERE id = v_id;
    IF NOT EXISTS (SELECT 1 FROM public.farmer_bundle_recommendations WHERE id = v_id AND affinity_bundle = 0.0094) THEN
      RAISE EXCEPTION 'A9 FALHOU: o CHECK recusou uma afinidade VALIDA (0.0094) — o motor nao conseguiria gravar';
    END IF;
    -- devolve a linha ao estado "afinidade nao medida" (esta migration nao inventa dado)
    UPDATE public.farmer_bundle_recommendations SET affinity_bundle = NULL WHERE id = v_id;
  ELSE
    RAISE NOTICE 'A7/A8/A9 PULADOS: farmer_bundle_recommendations vazia (nada a atualizar). Em prod ha 12 linhas.';
  END IF;

  RAISE NOTICE 'FU4-F fase 3: affinity_score/affinity_bundle criadas (numeric, sem default, finitas)';
END
$post$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDACAO POS-APPLY (read-only; esperado: 2 linhas numeric, sem default, e 2 CHECKs validados)
--
--   SELECT table_name, column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public'
--     AND ((table_name='farmer_recommendations'        AND column_name='affinity_score')
--       OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'));
--
--   SELECT conname, convalidated, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname LIKE '%affinity%finita';
-- ─────────────────────────────────────────────────────────────────────────────
