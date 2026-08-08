-- ============================================================
-- CHECK de FINITUDE em colunas `numeric` money-path (defesa no BANCO)
--
-- POR QUÊ (generalização do PR #1678): **guard posto no WRITER protege AQUELE
-- writer, não a TABELA.** O #1678 dropou `import_tint_formulas`, o 2º writer de
-- `tint_formula_itens` e o único sem o Guard 4 — mas a tabela seguiu sem defesa
-- PRÓPRIA: 0 CHECK constraints em 3.436.962 linhas. Qualquer writer FUTURO
-- reabre o buraco, e o writer futuro não aparece em nenhum fluxograma.
--
-- ⚠️ O guard de SINAL NÃO BASTA — em `numeric`, NaN é MAIOR que todo número.
--    Medido em prod (psql-ro, 2026-08-07):
--        ('NaN'::numeric > 0)                  = TRUE   ← CHECK (x > 0) ACEITA NaN
--        ('NaN'::numeric > 'Infinity'::numeric)= TRUE   ← NaN é o topo da ordem
--        ('NaN'::numeric <> 'NaN'::numeric)    = FALSE  ← mas <> NaN não pega Infinity
--    ⇒ fecham-se os TRÊS lados (docs/agent/money-path.md §2): > 0, <> NaN, < Infinity.
--    Os três predicados são mantidos EXPLÍCITOS de propósito: `> 0 AND < Infinity`
--    já bastaria (NaN > Infinity), mas a forma explícita é documentação executável
--    e resiste a uma "simplificação" futura que remova o lado errado.
--
-- Por que um número inválido aqui é caro: `qtd_ml` é a DOSE do corante na receita
-- tintométrica. NaN contamina a soma da fórmula inteira (`100 - NaN` = NaN) e
-- DESLIGA comparações de recusa (`1 > NaN` é FALSE) — não gera número errado,
-- gera AUSÊNCIA DE VETO. Infinity vira dose infinita com `errors: 0`.
--
-- PROVADO EXECUTANDO em PG17: `db/test-check-finitude-money-path.sh`
-- (falsificação inclusa: sabotar para `> 0` deixa NaN entrar; sabotar para
--  `> 0 AND <> NaN` deixa Infinity entrar — as duas ficam VERMELHAS).
--
-- ⚠️ MIGRATION MANUAL (nome custom não auto-aplica no Lovable — cole no SQL Editor).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- BLOCO 1 — tint_formula_itens.qtd_ml  (tabela NOVA na defesa: 0 CHECKs hoje)
--
-- 1.077 MB / 3.436.962 linhas ⇒ `ADD CONSTRAINT` direto faria scan completo sob
-- ACCESS EXCLUSIVE (trava a tabela). Padrão seguro: ADD ... NOT VALID (instantâneo,
-- passa a valer para escrita NOVA) + VALIDATE CONSTRAINT (scan sob SHARE UPDATE
-- EXCLUSIVE, que NÃO bloqueia leitura nem escrita).
--
-- Pré-medido em prod: 0 linhas violariam (nulos=0, NaN=0, Infinity=0, <=0 → 0).
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tint_formula_itens'
      AND con.conname = 'tint_formula_itens_qtd_ml_finita'
  ) THEN
    ALTER TABLE public.tint_formula_itens
      ADD CONSTRAINT tint_formula_itens_qtd_ml_finita
      CHECK (
        qtd_ml > 0
        AND qtd_ml <> 'NaN'::numeric
        AND qtd_ml < 'Infinity'::numeric
      ) NOT VALID;
    RAISE NOTICE 'tint_formula_itens_qtd_ml_finita: criada (NOT VALID)';
  ELSE
    RAISE NOTICE 'tint_formula_itens_qtd_ml_finita: ja existe';
  END IF;
END $$;

-- VALIDATE separado e idempotente (só roda se ainda estiver NOT VALID).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tint_formula_itens'
      AND con.conname = 'tint_formula_itens_qtd_ml_finita'
      AND NOT con.convalidated
  ) THEN
    ALTER TABLE public.tint_formula_itens
      VALIDATE CONSTRAINT tint_formula_itens_qtd_ml_finita;
    RAISE NOTICE 'tint_formula_itens_qtd_ml_finita: VALIDADA';
  ELSE
    RAISE NOTICE 'tint_formula_itens_qtd_ml_finita: ja validada';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- BLOCO 2 — cmc_snapshot.cmc  (guard EXISTENTE que NÃO guarda)
--
-- `cmc_snapshot_cmc_check` é hoje `CHECK ((cmc > (0)::numeric))` — a forma exata
-- que a medição acima mostra ACEITAR NaN e Infinity. Não é achado hipotético: é
-- um guard em produção que se lê como proteção e deixa passar os dois venenos.
-- `cmc` é o custo médio que alimenta margem e o piso de preço da régua.
--
-- Dado atual medido: 31.342 linhas, 0 NaN, 0 Infinity, 0 nulos ⇒ brecha LATENTE,
-- não explorada. O endurecimento é preventivo e aplica limpo.
--
-- 7.856 kB ⇒ DROP + ADD direto é seguro (scan trivial).
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_def
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'cmc_snapshot'
    AND con.conname = 'cmc_snapshot_cmc_check';

  IF v_def IS NULL THEN
    -- constraint ausente (banco divergente) — cria já na forma forte
    ALTER TABLE public.cmc_snapshot
      ADD CONSTRAINT cmc_snapshot_cmc_check
      CHECK (cmc > 0 AND cmc <> 'NaN'::numeric AND cmc < 'Infinity'::numeric);
    RAISE NOTICE 'cmc_snapshot_cmc_check: criada (forma forte)';
  ELSIF v_def LIKE '%Infinity%' THEN
    RAISE NOTICE 'cmc_snapshot_cmc_check: ja endurecida';
  ELSE
    ALTER TABLE public.cmc_snapshot DROP CONSTRAINT cmc_snapshot_cmc_check;
    ALTER TABLE public.cmc_snapshot
      ADD CONSTRAINT cmc_snapshot_cmc_check
      CHECK (cmc > 0 AND cmc <> 'NaN'::numeric AND cmc < 'Infinity'::numeric);
    RAISE NOTICE 'cmc_snapshot_cmc_check: ENDURECIDA (era %)', v_def;
  END IF;
END $$;

COMMENT ON CONSTRAINT tint_formula_itens_qtd_ml_finita ON public.tint_formula_itens IS
  'Dose do corante: finita e positiva. Os 3 lados (>0, <>NaN, <Infinity) porque em numeric NaN > 0 é TRUE — guard de sinal sozinho aceita NaN. Ver docs/agent/money-path.md §2.';
