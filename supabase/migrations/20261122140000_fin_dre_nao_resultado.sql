BEGIN;
-- ============================================================
-- DRE v1.13 — linha `nao_resultado` no mapa de categorias.
--
-- Por quê: `fora_dre` (fase 2) significa "composição PENDENTE (principal × juros)" e deixa o
-- resultado provisório. Movimento patrimonial DEFINITIVO (aporte de capital, distribuição de
-- lucro, compra de imobilizado, empréstimo TOMADO, aplicação/resgate, adiantamento, transferência)
-- não tem composição pendente: classificá-lo como fora_dre deixaria a DRE provisória por um
-- motivo falso (achado Codex, desenho 2026-11-22). A linha nova sai de todo subtotal SEM marcar
-- pendência. Desenho: docs/superpowers/specs/2026-11-22-dre-fluxo-caixa-mapa-proprio-design.md
--
-- Só o CHECK muda (nenhuma coluna nova: o total vai em detalhamento.nao_resultado). Mesmo padrão
-- do fora_dre: proibido no `_default` (código Omie NÃO é global — 1.04.04 é aporte na oben e
-- empréstimo na colacor_sc).
--
-- Ordem: esta migration → edge omie-financeiro v1.13 atestada → db/2026-11-22-fin-dre-mapa-proprio.sql
-- (a precondição de lá confere o motor servido). Mapa com nao_resultado sob o motor v1.12 cai em
-- `valor_desconhecido` ⇒ heurística + mapeado:false + confiança baixa — degrada, não fabrica.
-- ============================================================

ALTER TABLE public.fin_categoria_dre_mapping
  DROP CONSTRAINT IF EXISTS fin_categoria_dre_mapping_dre_linha_check;
ALTER TABLE public.fin_categoria_dre_mapping
  ADD CONSTRAINT fin_categoria_dre_mapping_dre_linha_check CHECK (dre_linha = ANY (ARRAY[
    'receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_administrativas',
    'despesas_comerciais', 'despesas_financeiras', 'receitas_financeiras', 'outras_receitas',
    'outras_despesas', 'impostos',
    'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll',
    'fora_dre', 'nao_resultado'
  ]::text[]));

ALTER TABLE public.fin_categoria_dre_mapping
  DROP CONSTRAINT IF EXISTS fin_categoria_dre_mapping_fora_dre_por_empresa_check;
ALTER TABLE public.fin_categoria_dre_mapping
  ADD CONSTRAINT fin_categoria_dre_mapping_fora_dre_por_empresa_check
  CHECK (NOT (company = '_default' AND dre_linha IN ('fora_dre', 'nao_resultado')));

-- ── postcondição: aborta a transação se qualquer peça não pegou ──
DO $post$
DECLARE
  v_def text;
  v_falta text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.fin_categoria_dre_mapping'::regclass
     AND conname = 'fin_categoria_dre_mapping_dre_linha_check' AND convalidated;
  IF v_def IS NULL THEN RAISE EXCEPTION 'postcondicao: CHECK de dre_linha ausente ou nao validado'; END IF;
  SELECT array_agg(x) INTO v_falta FROM unnest(ARRAY[
    'receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas',
    'despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas',
    'outras_despesas','impostos','ded_icms','ded_iss','ded_pis','ded_cofins','ded_ipi','das',
    'irpj','csll','fora_dre','nao_resultado']) x
   WHERE position('''' || x || '''' IN v_def) = 0;
  IF v_falta IS NOT NULL THEN RAISE EXCEPTION 'postcondicao: CHECK sem os valores %', v_falta; END IF;

  -- comportamento, não só existência. Aceite: sub-bloco termina num RAISE próprio (P0099) que
  -- desfaz a linha de prova. Recusa: só check_violation conta; qualquer outro erro sobe.
  BEGIN
    INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
      VALUES ('colacor', '__postcondicao_nao_resultado__', 'nao_resultado');
    RAISE EXCEPTION 'desfaz linha de prova' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
      VALUES ('_default', '__postcondicao_nao_resultado__', 'nao_resultado');
    RAISE EXCEPTION 'postcondicao: _default aceitou nao_resultado';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
      VALUES ('_default', '__postcondicao_nao_resultado__', 'fora_dre');
    RAISE EXCEPTION 'postcondicao: _default aceitou fora_dre';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
      VALUES ('colacor', '__postcondicao_nao_resultado__', 'linha_inexistente');
    RAISE EXCEPTION 'postcondicao: CHECK aceitou linha inexistente';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.fin_categoria_dre_mapping WHERE omie_codigo = '__postcondicao_nao_resultado__') THEN
    RAISE EXCEPTION 'postcondicao: linha de prova sobrou';
  END IF;
END
$post$;
COMMIT;
