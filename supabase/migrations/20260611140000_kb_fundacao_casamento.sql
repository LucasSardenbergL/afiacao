-- =========================================================================
-- Fundação KB — casamento boletim ↔ item de venda (PR-0a). ADITIVO.
-- ⚠️ MIGRATION MANUAL: colar no SQL Editor do Lovable (CLAUDE.md §5).
-- =========================================================================

-- BLOCO A: identidade do código do boletim
ALTER TABLE public.kb_product_specs
  ADD COLUMN IF NOT EXISTS product_code_normalized text;

-- Normalização (espelha src/lib/knowledge-base/code-normalize.ts normalizeProductCode):
-- upper + remove espaços + trim. Mantém pontos/sufixo. Supplier canonicalizado p/ lower.
CREATE OR REPLACE FUNCTION public.kb_specs_normalize() RETURNS trigger AS $$
BEGIN
  -- NFKC → upper → remove espaços → trim (espelha normalizeProductCode do helper TS)
  NEW.product_code_normalized :=
    btrim(regexp_replace(upper(normalize(coalesce(NEW.product_code, ''), NFKC)), '\s+', '', 'g'));
  NEW.supplier := lower(btrim(coalesce(NEW.supplier, 'sayerlack')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kb_specs_normalize ON public.kb_product_specs;
CREATE TRIGGER trg_kb_specs_normalize
  BEFORE INSERT OR UPDATE OF product_code, supplier ON public.kb_product_specs
  FOR EACH ROW EXECUTE FUNCTION public.kb_specs_normalize();

-- Backfill (base vazia hoje → no-op; idempotente):
UPDATE public.kb_product_specs
  SET product_code_normalized = btrim(regexp_replace(upper(normalize(coalesce(product_code, ''), NFKC)), '\s+', '', 'g')),
      supplier = lower(btrim(coalesce(supplier, 'sayerlack')))
  WHERE product_code_normalized IS DISTINCT FROM
        btrim(regexp_replace(upper(normalize(coalesce(product_code, ''), NFKC)), '\s+', '', 'g'));

-- Identidade composta ADICIONAL (a UNIQUE(product_code) global segue por ora):
ALTER TABLE public.kb_product_specs
  DROP CONSTRAINT IF EXISTS kb_product_specs_supplier_code_norm_key;
ALTER TABLE public.kb_product_specs
  ADD CONSTRAINT kb_product_specs_supplier_code_norm_key
  UNIQUE (supplier, product_code_normalized);

-- BLOCO B: vínculo confirmado boletim ↔ SKU Omie (a chave Omie é COMPOSTA)
CREATE TABLE IF NOT EXISTS public.omie_product_spec_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  kb_product_spec_id uuid NOT NULL REFERENCES public.kb_product_specs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','rejected')),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ≤1 spec CONFIRMADO ativo por SKU (account+codigo). Múltiplos 'rejected' permitidos.
CREATE UNIQUE INDEX IF NOT EXISTS omie_product_spec_links_one_confirmed
  ON public.omie_product_spec_links (account, omie_codigo_produto)
  WHERE status = 'confirmed';

-- Não duplicar o mesmo trio (sku, spec, status).
CREATE UNIQUE INDEX IF NOT EXISTS omie_product_spec_links_unique_triple
  ON public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status);

ALTER TABLE public.omie_product_spec_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS omie_product_spec_links_select_staff ON public.omie_product_spec_links;
CREATE POLICY omie_product_spec_links_select_staff
  ON public.omie_product_spec_links FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role));

-- BLOCO C: fonte única que a venda/copilot leem. Dupla trava: confirmed + approved.
CREATE OR REPLACE VIEW public.v_omie_product_current_spec
WITH (security_invoker = on) AS
SELECT
  l.account, l.omie_codigo_produto, l.kb_product_spec_id,
  s.product_code, s.product_name, s.supplier, s.product_category,
  s.rendimento_m2_por_litro, s.demaos_recomendadas, s.pot_life_horas, s.validade_dias,
  s.catalisador_codigo, s.catalisador_proporcao_pct, s.diluente_codigo,
  s.substrato, s.equipamentos_aplicacao, s.diferenciais_chave, s.uso_recomendado
FROM public.omie_product_spec_links l
JOIN public.kb_product_specs s ON s.id = l.kb_product_spec_id
WHERE l.status = 'confirmed'
  AND s.approved_at IS NOT NULL;

-- BLOCO D: pré-filtro server-side (busca reversa). Refino exato é client-side. Staff-gated.
CREATE OR REPLACE FUNCTION public.buscar_skus_candidatos(p_termos text[])
RETURNS TABLE (account text, omie_codigo_produto bigint, codigo text, descricao text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee'::app_role)
       OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_termos IS NULL OR array_length(p_termos, 1) IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT op.account, op.omie_codigo_produto, op.codigo, op.descricao
  FROM public.omie_products op
  WHERE op.ativo IS NOT FALSE
    AND EXISTS (
      SELECT 1 FROM unnest(p_termos) t
      -- escapa metacaracteres LIKE (ordem: '\' primeiro) — termo vem de input, evita '%' casar tudo
      WHERE upper(op.descricao) LIKE
        '%' || replace(replace(replace(upper(t), '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY op.account, op.descricao
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.buscar_skus_candidatos(text[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.buscar_skus_candidatos(text[]) TO authenticated;

-- BLOCO E: gravar o vínculo. Gate MASTER (founder cura a base). confirmed_by = auth.uid().
CREATE OR REPLACE FUNCTION public.confirmar_vinculo_boletim(
  p_kb_product_spec_id uuid, p_skus jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb; v_account text; v_cod bigint; v_count integer := 0; v_dono uuid;
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
    SELECT kb_product_spec_id INTO v_dono FROM public.omie_product_spec_links
      WHERE account = v_account AND omie_codigo_produto = v_cod AND status = 'confirmed';
    IF v_dono IS NOT NULL AND v_dono <> p_kb_product_spec_id THEN
      RAISE EXCEPTION 'SKU %/% já vinculado a outro boletim', v_account, v_cod;
    END IF;
    INSERT INTO public.omie_product_spec_links
      (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
    VALUES (v_account, v_cod, p_kb_product_spec_id, 'confirmed', v_uid)
    ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.rejeitar_sugestao(
  p_kb_product_spec_id uuid, p_account text, p_omie_codigo_produto bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  INSERT INTO public.omie_product_spec_links
    (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
  VALUES (p_account, p_omie_codigo_produto, p_kb_product_spec_id, 'rejected', auth.uid())
  ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_vinculo_boletim(uuid, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.rejeitar_sugestao(uuid, text, bigint) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.confirmar_vinculo_boletim(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rejeitar_sugestao(uuid, text, bigint) TO authenticated;
