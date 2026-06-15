-- =========================================================================
-- KB 0c — caminho A: aprovação de spec MASTER-ONLY + endurecimento de vínculos.
-- ⚠️ MIGRATION MANUAL: colar no SQL Editor do Lovable (CLAUDE.md §5). ADITIVO.
-- Continuação de 20260611140000_kb_fundacao_casamento.sql.
-- Spec: docs/superpowers/specs/2026-06-13-kb-0c-aprovacao-master-only-design.md
-- =========================================================================

-- BLOCO A: aprovação master-only — fecha o P1 (employee adulterava os números da venda).
-- A RLS antiga deixava INSERT por qualquer staff e UPDATE por extracted_by=auth.uid() (de QUALQUER coluna).
-- Curadoria da base é do founder (V1-C) → escrita SÓ master. SELECT (staff) e DELETE (master) ficam INTACTAS.
-- DROP IF EXISTS dos nomes ANTIGOS (a substituir) E dos NOVOS → bloco re-rodável no SQL Editor (idempotente, CLAUDE.md §5).
DROP POLICY IF EXISTS "kb_product_specs_insert_staff"  ON public.kb_product_specs;
DROP POLICY IF EXISTS "kb_product_specs_insert_master" ON public.kb_product_specs;
DROP POLICY IF EXISTS "kb_product_specs_update_master" ON public.kb_product_specs;

CREATE POLICY "kb_product_specs_insert_master" ON public.kb_product_specs
  FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'master'::app_role));

CREATE POLICY "kb_product_specs_update_master" ON public.kb_product_specs
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::app_role));

-- BLOCO B: CHECKs de não-negatividade nos campos numéricos que a venda exibe pela view
-- (Codex P2: extração errada não publica rendimento negativo / catalisador absurdo). Base vazia → ADD direto.
ALTER TABLE public.kb_product_specs
  DROP CONSTRAINT IF EXISTS kb_spec_rendimento_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_demaos_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_potlife_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_validade_nonneg,
  DROP CONSTRAINT IF EXISTS kb_spec_catalisador_pct_nonneg;
ALTER TABLE public.kb_product_specs
  ADD CONSTRAINT kb_spec_rendimento_nonneg      CHECK (rendimento_m2_por_litro   IS NULL OR rendimento_m2_por_litro   >= 0),
  ADD CONSTRAINT kb_spec_demaos_nonneg          CHECK (demaos_recomendadas       IS NULL OR demaos_recomendadas       >= 0),
  ADD CONSTRAINT kb_spec_potlife_nonneg         CHECK (pot_life_horas            IS NULL OR pot_life_horas            >= 0),
  ADD CONSTRAINT kb_spec_validade_nonneg        CHECK (validade_dias            IS NULL OR validade_dias            >= 0),
  ADD CONSTRAINT kb_spec_catalisador_pct_nonneg CHECK (catalisador_proporcao_pct IS NULL OR catalisador_proporcao_pct >= 0);

-- BLOCO C: confirmar_vinculo_boletim — + valida SKU em omie_products (P2-a) + contador real (P3, ROW_COUNT).
-- Resto VERBATIM da 20260611140000: gate master, spec existe, anti-roubo, ON CONFLICT DO NOTHING.
-- (CREATE OR REPLACE preserva os GRANTs já dados na fundação — mesma assinatura uuid,jsonb.)
CREATE OR REPLACE FUNCTION public.confirmar_vinculo_boletim(
  p_kb_product_spec_id uuid, p_skus jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb; v_account text; v_cod bigint; v_count integer := 0; v_dono uuid; v_ins integer;
BEGIN
  IF NOT public.has_role(v_uid, 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kb_product_specs WHERE id = p_kb_product_spec_id) THEN
    RAISE EXCEPTION 'spec inexistente';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_account := v_item->>'account';
    v_cod := (v_item->>'omie_codigo_produto')::bigint;
    -- P2-a: o SKU tem que existir no catálogo Omie (mata vínculo-fantasma: account vazio/caixa errada/SKU inexistente).
    IF NOT EXISTS (SELECT 1 FROM public.omie_products
                    WHERE omie_codigo_produto = v_cod AND account = v_account) THEN
      RAISE EXCEPTION 'SKU %/% inexistente em omie_products', v_account, v_cod;
    END IF;
    SELECT kb_product_spec_id INTO v_dono FROM public.omie_product_spec_links
      WHERE account = v_account AND omie_codigo_produto = v_cod AND status = 'confirmed';
    IF v_dono IS NOT NULL AND v_dono <> p_kb_product_spec_id THEN
      RAISE EXCEPTION 'SKU %/% já vinculado a outro boletim', v_account, v_cod;
    END IF;
    INSERT INTO public.omie_product_spec_links
      (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
    VALUES (v_account, v_cod, p_kb_product_spec_id, 'confirmed', v_uid)
    ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;     -- P3: só conta o que REALMENTE inseriu (DO NOTHING → 0).
    v_count := v_count + v_ins;
  END LOOP;
  RETURN v_count;
END;
$$;

-- BLOCO D: desvincular_boletim — desfaz/reatribui um 'confirmed' errado (master).
-- p_expected_kb_product_spec_id evita STALE-DELETE (Codex P2): aba atrasada não apaga vínculo já reatribuído.
CREATE OR REPLACE FUNCTION public.desvincular_boletim(
  p_account text, p_omie_codigo_produto bigint, p_expected_kb_product_spec_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  DELETE FROM public.omie_product_spec_links
   WHERE account = p_account
     AND omie_codigo_produto = p_omie_codigo_produto
     AND status = 'confirmed'
     AND kb_product_spec_id = p_expected_kb_product_spec_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;     -- 0 = nada batia (não vinculado, ou já reatribuído = stale UI).
END;
$$;

REVOKE ALL ON FUNCTION public.desvincular_boletim(text, bigint, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.desvincular_boletim(text, bigint, uuid) TO authenticated;
