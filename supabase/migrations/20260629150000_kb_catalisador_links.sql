-- ============================================================
-- kb_catalisador_links — casamento catalisador_codigo (normalizado) ↔ SKU Omie
-- Venda assistida: destrava o preço CATALISADO no selo. Espelha o padrão de
-- omie_product_spec_links / confirmar_vinculo_boletim (20260611140000_kb_fundacao_casamento.sql).
-- Plano: docs/superpowers/plans/2026-06-29-venda-assistida-catalisador-casamento.md
-- ============================================================

-- ── Normalizador da chave do catalisador (UPPER + só alfanumérico) ──
-- IMMUTABLE: usada na gravação E no lookup → 'FC.6975' e 'FC 6975' viram 'FC6975'.
CREATE OR REPLACE FUNCTION public.kb_normalizar_catalisador(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(coalesce(p, ''), '[^a-zA-Z0-9]', '', 'g'));
$$;

-- ── Tabela: catalisador (normalizado) → SKU Omie (a chave Omie é COMPOSTA account+cod) ──
CREATE TABLE IF NOT EXISTS public.kb_catalisador_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalisador_codigo_norm text NOT NULL,
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','rejected')),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ≤1 catalisador CONFIRMADO por SKU (account+cod). Múltiplos 'rejected' permitidos.
CREATE UNIQUE INDEX IF NOT EXISTS kb_catalisador_links_one_confirmed
  ON public.kb_catalisador_links (account, omie_codigo_produto)
  WHERE status = 'confirmed';

-- Não duplicar o mesmo quarteto (norm, sku, status).
CREATE UNIQUE INDEX IF NOT EXISTS kb_catalisador_links_unique_quad
  ON public.kb_catalisador_links (catalisador_codigo_norm, account, omie_codigo_produto, status);

-- Lookup do selo: por (código normalizado, conta) entre os confirmados.
CREATE INDEX IF NOT EXISTS kb_catalisador_links_norm
  ON public.kb_catalisador_links (catalisador_codigo_norm, account)
  WHERE status = 'confirmed';

-- ── RLS: staff lê; escrita só via RPC SECURITY DEFINER (master) ──
ALTER TABLE public.kb_catalisador_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_catalisador_links_select_staff ON public.kb_catalisador_links;
CREATE POLICY kb_catalisador_links_select_staff
  ON public.kb_catalisador_links FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role));

-- ── RPC: confirmar o casamento do catalisador. Gate MASTER. Normaliza a chave. ──
CREATE OR REPLACE FUNCTION public.confirmar_catalisador_vinculo(
  p_catalisador_codigo text, p_skus jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_norm text := public.kb_normalizar_catalisador(p_catalisador_codigo);
  v_item jsonb; v_account text; v_cod bigint; v_count integer := 0; v_dono text;
BEGIN
  IF NOT public.has_role(v_uid, 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  IF v_norm = '' THEN
    RAISE EXCEPTION 'catalisador_codigo vazio apos normalizacao';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_account := v_item->>'account';
    v_cod := (v_item->>'omie_codigo_produto')::bigint;
    -- ≤1 catalisador por SKU: se o SKU já é catalisador de OUTRO código, barra.
    SELECT catalisador_codigo_norm INTO v_dono FROM public.kb_catalisador_links
      WHERE account = v_account AND omie_codigo_produto = v_cod AND status = 'confirmed';
    IF v_dono IS NOT NULL AND v_dono <> v_norm THEN
      RAISE EXCEPTION 'SKU %/% ja e catalisador de outro codigo (%)', v_account, v_cod, v_dono;
    END IF;
    INSERT INTO public.kb_catalisador_links
      (catalisador_codigo_norm, account, omie_codigo_produto, status, confirmed_by)
    VALUES (v_norm, v_account, v_cod, 'confirmed', v_uid)
    ON CONFLICT (catalisador_codigo_norm, account, omie_codigo_produto, status) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── RPC: desvincular um SKU do catalisador. Gate MASTER. Guard anti-stale (norm esperado). ──
CREATE OR REPLACE FUNCTION public.desvincular_catalisador(
  p_account text, p_omie_codigo_produto bigint, p_expected_norm text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  DELETE FROM public.kb_catalisador_links
   WHERE account = p_account
     AND omie_codigo_produto = p_omie_codigo_produto
     AND status = 'confirmed'
     AND catalisador_codigo_norm = public.kb_normalizar_catalisador(p_expected_norm);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ── Grants (espelha a casar) ──
REVOKE ALL ON FUNCTION public.kb_normalizar_catalisador(text) FROM anon, public;
REVOKE ALL ON FUNCTION public.confirmar_catalisador_vinculo(text, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.desvincular_catalisador(text, bigint, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.kb_normalizar_catalisador(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_catalisador_vinculo(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.desvincular_catalisador(text, bigint, text) TO authenticated;
