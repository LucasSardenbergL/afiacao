-- ============================================================================================
-- APLICAÇÃO via `bun run db:aplicar` — DRE fase 2: CHECK ampliado + colunas fora_dre/provisório
--
-- Mesmo EFEITO da migration `20261013230000_fin_dre_fora_dre_fase2.sql`, SEM os envelopes
-- `BEGIN;`/`COMMIT;`: a transação é do `db:aplicar`.
--
-- Paridade derivada, não digitada:
--   diff <(sed '/^BEGIN;$/d;/^COMMIT;$/d' supabase/migrations/20261013230000_fin_dre_fora_dre_fase2.sql) \
--        <(sed '1,/^-- FIM DO CABEÇALHO DESTE ARQUIVO$/d' db/2026-10-13-fin-dre-fora-dre-fase2.sql)
-- tem de sair VAZIO.
-- FIM DO CABEÇALHO DESTE ARQUIVO
-- ============================================================
-- DRE fase 2 — linha `fora_dre` (composição pendente) + impostos em linha própria
--
-- POR QUÊ: no DRE caixa colacor 2026 (psql-ro, 2026-10-13) R$ 260.988,78 de saídas que NÃO são
-- despesa do período (empréstimo 2.05.03, imobilizado 2.01.99, parcelamento 2.06.90) caíam em
-- `despesas_operacionais` por fallback, e ICMS/PIS/COFINS idem. O motor (omie-financeiro
-- calcularDRE) já conhece as linhas `ded_*`/`das`/`irpj`/`csll`, mas o CHECK do mapa só aceitava
-- 11 valores — não havia como mapear imposto em linha própria nem segregar fora do DRE.
--
-- O QUE FAZ (aditivo; nenhum dado existente muda):
--   1. CHECK de `fin_categoria_dre_mapping.dre_linha` passa a aceitar as linhas que o motor já
--      honra: ded_icms, ded_iss, ded_pis, ded_cofins, ded_ipi, das, irpj, csll e fora_dre.
--      Os 11 valores de hoje continuam válidos (inclusive o legado 'impostos').
--   2. `fora_dre` é proibido em company='_default': sair do DRE é decisão de natureza POR
--      EMPRESA; um _default levaria a decisão de uma empresa para as outras.
--   3. `fin_dre_snapshots` ganha `fora_dre numeric(15,2)` e `resultado_provisorio boolean`,
--      NULLABLE e SEM default: NULL = snapshot pré-fase 2 (nada segregado, nada declarado).
--      Ausente ≠ zero: um default 0/false afirmaria "sem pendência" em mês que o motor novo
--      nunca calculou. Writer único: calcularDRE (upsert company,ano,mes,regime).
--   4. Gatilho: gravação SEM `detalhamento.contrato` (motor legado, rollback) zera as duas colunas
--      para NULL — o metadado nunca sobrevive a um resultado recalculado por outro motor.
--
-- ORDEM DE DEPLOY: esta migration ANTES da edge omie-financeiro nova (o upsert dela grava as
-- colunas — sem elas o PostgREST recusa e o cálculo FALHA ALTO, não silencioso). O mapa colacor
-- (db/ script) só DEPOIS da edge atestada.
-- ============================================================

ALTER TABLE public.fin_categoria_dre_mapping
  DROP CONSTRAINT IF EXISTS fin_categoria_dre_mapping_dre_linha_check;
ALTER TABLE public.fin_categoria_dre_mapping
  ADD CONSTRAINT fin_categoria_dre_mapping_dre_linha_check CHECK (dre_linha = ANY (ARRAY[
    'receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_administrativas',
    'despesas_comerciais', 'despesas_financeiras', 'receitas_financeiras', 'outras_receitas',
    'outras_despesas', 'impostos',
    'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll',
    'fora_dre'
  ]::text[]));

ALTER TABLE public.fin_categoria_dre_mapping
  DROP CONSTRAINT IF EXISTS fin_categoria_dre_mapping_fora_dre_por_empresa_check;
ALTER TABLE public.fin_categoria_dre_mapping
  ADD CONSTRAINT fin_categoria_dre_mapping_fora_dre_por_empresa_check
  CHECK (NOT (company = '_default' AND dre_linha = 'fora_dre'));

ALTER TABLE public.fin_dre_snapshots ADD COLUMN IF NOT EXISTS fora_dre numeric(15,2);
ALTER TABLE public.fin_dre_snapshots ADD COLUMN IF NOT EXISTS resultado_provisorio boolean;

COMMENT ON COLUMN public.fin_dre_snapshots.fora_dre IS
  'DRE fase 2: saídas classificadas fora do DRE (empréstimo/parcelamento/CAPEX/imobilizado), fora de todo subtotal. NULL = snapshot pré-fase 2. Composição em detalhamento.fora_dre.';
COMMENT ON COLUMN public.fin_dre_snapshots.resultado_provisorio IS
  'DRE fase 2: true = há movimentação fora_dre com composição pendente (principal × juros) — resultado provisório. false = sem pendência fora_dre identificada (NÃO é lucro validado). NULL = pré-fase 2.';

-- Writer SEM o contrato fase 2 (rollback do omie-financeiro para v1.4) não pode herdar o metadado de
-- outra apuração: o upsert antigo só reescreve as colunas que conhece, e `fora_dre=0`/`provisorio=false`
-- de um cálculo novo ficariam ao lado de um resultado legado (empréstimo de volta como despesa). Sem
-- `detalhamento.contrato` ⇒ as duas colunas viram NULL = "não declarado", nunca "sem pendência".
CREATE OR REPLACE FUNCTION public.fin_dre_snapshots_contrato_fase2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $f$
BEGIN
  IF NEW.detalhamento IS NULL OR NOT (NEW.detalhamento ? 'contrato') THEN
    NEW.fora_dre := NULL;
    NEW.resultado_provisorio := NULL;
  END IF;
  RETURN NEW;
END
$f$;
CREATE OR REPLACE TRIGGER trg_fin_dre_snapshots_contrato_fase2
  BEFORE INSERT OR UPDATE ON public.fin_dre_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fin_dre_snapshots_contrato_fase2();

-- ── postcondição: aborta a transação se qualquer peça não pegou ──
DO $post$
DECLARE
  v_def text;
  v_falta text[];
  v_cols int;
  v_fd numeric;
  v_prov boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.fin_categoria_dre_mapping'::regclass
     AND conname = 'fin_categoria_dre_mapping_dre_linha_check';
  IF v_def IS NULL THEN RAISE EXCEPTION 'postcondicao: CHECK de dre_linha ausente'; END IF;
  SELECT array_agg(x) INTO v_falta FROM unnest(ARRAY[
    'receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas',
    'despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas',
    'outras_despesas','impostos','ded_icms','ded_iss','ded_pis','ded_cofins','ded_ipi','das',
    'irpj','csll','fora_dre']) x
   WHERE position('''' || x || '''' IN v_def) = 0;
  IF v_falta IS NOT NULL THEN RAISE EXCEPTION 'postcondicao: CHECK sem os valores %', v_falta; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fin_categoria_dre_mapping'::regclass
                    AND conname = 'fin_categoria_dre_mapping_fora_dre_por_empresa_check'
                    AND convalidated) THEN
    RAISE EXCEPTION 'postcondicao: CHECK fora_dre por empresa ausente ou nao validado';
  END IF;
  -- comportamento, não só existência: um CHECK com o nome certo e corpo frouxo passaria acima.
  -- O INSERT de prova vive num sub-bloco; check_violation o desfaz, qualquer outro erro sobe.
  BEGIN
    INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
      VALUES ('_default', '__postcondicao_fase2__', 'fora_dre');
    RAISE EXCEPTION 'postcondicao: _default aceitou fora_dre';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'fin_dre_snapshots'
     AND ((column_name = 'fora_dre' AND data_type = 'numeric' AND numeric_precision = 15 AND numeric_scale = 2)
       OR (column_name = 'resultado_provisorio' AND data_type = 'boolean'))
     AND is_nullable = 'YES' AND column_default IS NULL;
  -- gatilho por COMPORTAMENTO: grava como o writer legado (sem contrato) e exige NULL; o sub-bloco
  -- termina num RAISE próprio (P0099) que desfaz a linha de prova — qualquer outro erro sobe.
  BEGIN
    INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, detalhamento, fora_dre, resultado_provisorio)
      VALUES ('colacor', 1900, 1, 'caixa', '{"receitas":{}}'::jsonb, 1, false)
      RETURNING fora_dre, resultado_provisorio INTO v_fd, v_prov;
    IF v_fd IS NOT NULL OR v_prov IS NOT NULL THEN
      RAISE EXCEPTION 'postcondicao: writer sem contrato manteve fora_dre/provisorio (gatilho ausente)';
    END IF;
    RAISE EXCEPTION 'desfaz linha de prova' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, detalhamento, fora_dre, resultado_provisorio)
      VALUES ('colacor', 1900, 1, 'caixa', '{"contrato":{"versao":"dre-fora-dre-v1"}}'::jsonb, 1, true)
      RETURNING fora_dre, resultado_provisorio INTO v_fd, v_prov;
    IF v_fd IS DISTINCT FROM 1 OR v_prov IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'postcondicao: writer com contrato perdeu fora_dre/provisorio';
    END IF;
    RAISE EXCEPTION 'desfaz linha de prova' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  IF v_cols IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'postcondicao: colunas fase 2 de fin_dre_snapshots erradas (% de 2)', v_cols; END IF;
END
$post$;
