-- Passo 1 do flip tintométrico: a RPC de preço passa a INCLUIR A BASE.
--
-- Antes: custoBase=0, precoFinal = só corantes (a base era somada à mão no
-- frontend, via product.valor_unitario). Frágil e não auto-suficiente — bloqueia
-- aposentar o CSV (preco_final_sayersystem).
--
-- Agora: resolve a base pela própria fórmula (tint_formulas -> tint_skus ->
-- omie_products.valor_unitario) e devolve precoFinal = base + corantes.
-- Money-path (ausente != zero): precoFinal/custoBase são NULL quando a base não
-- tem preço (ex.: PRD03657 valor_unitario=0) OU quando qualquer corante não tem
-- custo no Omie — nunca um número subfaturado. custoCorantes ainda traz a soma
-- parcial (exibição) e corantesCompletos/baseDisponivel sinalizam o porquê.
--
-- Espelha verbatim o helper TS src/lib/tint/compute-price.ts (oráculo de paridade).
-- Hardening preservado: itensCorantes (a receita) só volta preenchido para staff.
-- Provado em db/test-tint-get-price.sh (PG17 falsificável).

CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_staff boolean;
  v_base_preco numeric;
  v_base_disponivel boolean;
  v_custo_base numeric;
  v_custo_corantes numeric;
  v_corantes_completos boolean;
  v_preco_final numeric;
  v_itens jsonb;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));

  -- Base: preço do produto Omie vinculado ao SKU da fórmula.
  SELECT op.valor_unitario INTO v_base_preco
  FROM tint_formulas f
  LEFT JOIN tint_skus s ON s.id = f.sku_id
  LEFT JOIN omie_products op ON op.id = s.omie_product_id
  WHERE f.id = p_formula_id;

  v_base_disponivel := v_base_preco IS NOT NULL AND v_base_preco > 0;
  v_custo_base := CASE WHEN v_base_disponivel THEN v_base_preco ELSE NULL END;

  -- Corantes: Σ (qtd_ml × valor_unitario / volume_total_ml); custo_disponivel por item.
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
    COALESCE(bool_and(custo_disponivel), true),   -- fórmula sem itens => true (vacuamente completa)
    COALESCE(jsonb_agg(jsonb_build_object(
      'coranteDescricao', corante_descricao, 'qtdMl', qtd_ml, 'custoPorMl', custo_por_ml,
      'custoItem', custo_item, 'custoDisponivel', custo_disponivel
    ) ORDER BY ordem), '[]'::jsonb)
  INTO v_custo_corantes, v_corantes_completos, v_itens
  FROM calc;

  -- Money-path: só há preço quando a base existe E todos os corantes têm custo.
  v_preco_final := CASE WHEN v_base_disponivel AND v_corantes_completos
                        THEN v_custo_base + v_custo_corantes ELSE NULL END;

  RETURN jsonb_build_object(
    'custoBase', v_custo_base,
    'baseDisponivel', v_base_disponivel,
    'custoCorantes', v_custo_corantes,
    'corantesCompletos', v_corantes_completos,
    'precoFinal', v_preco_final,
    'itensCorantes', CASE WHEN v_is_staff THEN v_itens ELSE '[]'::jsonb END
  );
END; $function$;
