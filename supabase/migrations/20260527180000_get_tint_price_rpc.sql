-- Fase 1 do hardening da receita tintométrica (spec
-- docs/superpowers/specs/2026-05-27-tint-recipe-hardening-design.md).
-- Cria a RPC SECURITY DEFINER que computa o preço de uma fórmula server-side,
-- para que o cliente obtenha o PREÇO sem precisar ler `tint_formula_itens` (a
-- "receita" = corante_id + qtd_ml, IP central). O gate de staff devolve o
-- breakdown completo (`itensCorantes`) ao operador; ao cliente, só o agregado.
--
-- O cálculo espelha VERBATIM o helper puro testado `computeTintPrice`
-- (src/lib/tint/compute-price.ts): custoItem = qtd_ml × valor_unitario/volume_total_ml.
-- Diferença float (JS) × numeric (SQL) é sub-centavo e arredondada no consumidor.
--
-- ⚠️ ESTA migration NÃO aperta a RLS de `tint_formula_itens` — isso é a Fase 3,
-- aplicada SÓ depois de o front-end (Fase 2) já consumir esta RPC em produção,
-- senão o app antigo (que lê a tabela direto) quebraria. Aplicada manualmente no
-- Lovable e validada por paridade de preço antes do cutover (2026-05-27).

CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_staff boolean;
  v_custo_corantes numeric;
  v_itens jsonb;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL
    AND (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role));

  WITH calc AS (
    SELECT
      fi.ordem,
      COALESCE(c.descricao, '?') AS corante_descricao,
      fi.qtd_ml,
      (op.valor_unitario IS NOT NULL AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0) AS custo_disponivel,
      CASE WHEN op.valor_unitario IS NOT NULL AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN op.valor_unitario / c.volume_total_ml ELSE 0 END AS custo_por_ml,
      CASE WHEN op.valor_unitario IS NOT NULL AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN fi.qtd_ml * (op.valor_unitario / c.volume_total_ml) ELSE 0 END AS custo_item
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = p_formula_id
  )
  SELECT
    COALESCE(SUM(custo_item), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'coranteDescricao', corante_descricao,
      'qtdMl', qtd_ml,
      'custoPorMl', custo_por_ml,
      'custoItem', custo_item,
      'custoDisponivel', custo_disponivel
    ) ORDER BY ordem), '[]'::jsonb)
  INTO v_custo_corantes, v_itens
  FROM calc;

  RETURN jsonb_build_object(
    'custoBase', 0,
    'custoCorantes', v_custo_corantes,
    'precoFinal', v_custo_corantes,
    'itensCorantes', CASE WHEN v_is_staff THEN v_itens ELSE '[]'::jsonb END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_tint_price(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid) TO authenticated;
