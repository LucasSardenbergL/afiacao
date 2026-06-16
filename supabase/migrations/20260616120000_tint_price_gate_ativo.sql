-- Passo 1c do flip tintométrico: GATE DE `ativo` no preço (achado adversarial Codex, 16/06).
--
-- Furo: get_tint_price/get_tint_prices marcavam a base "disponível" só por
-- valor_unitario > 0 — IGNORAVAM omie_products.ativo. Uma base (ou corante) que a
-- empresa DESATIVOU no Omie, mas que ainda tem valor_unitario congelado > 0,
-- seguia precificada e VENDÁVEL no balcão. O sync TRAZ produtos inativos
-- (oben 2.757 / colacor 2.117) e desativar NÃO zera o valor (3.606 inativos com
-- valor > 0 hoje) — o furo é LATENTE, não teórico: a 1ª base/corante tintométrico
-- desativado com fórmula viva passaria a vender produto morto, em silêncio.
--
-- Correção (fronteira money-path única — o front herda "sem preço" via
-- src/lib/tint/select-price.ts: precoFinal NULL => "Adicionar" desabilita): base e
-- corante só entram no preço se o produto Omie estiver ATIVO. Mesma régua de
-- "ausente != zero": inativo => baseDisponivel / custo_disponivel = false =>
-- precoFinal NULL (fail closed, self-healing no Omie), nunca o preço de um produto
-- descontinuado. O gate do corante é simetria com a blindagem de preço ≤0 já feita
-- (mesma família: custo de insumo não-confiável).
--
-- Impacto na aplicação: ZERO regressão — medido em prod, 0 fórmulas vivas têm base
-- OU corante inativo hoje; é blindagem preventiva, não muda nenhum preço atual.
-- Espelha o helper TS src/lib/tint/compute-price.ts (manter paridade — atualizar lá).
-- Provado em db/test-tint-get-price.sh + db/test-tint-get-prices.sh (PG17, F5/F6).

CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_staff boolean;
  v_base_preco numeric;
  v_base_ativo boolean;
  v_base_disponivel boolean;
  v_custo_base numeric;
  v_custo_corantes numeric;
  v_corantes_completos boolean;
  v_preco_final numeric;
  v_itens jsonb;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));

  -- Base: preço E status do produto Omie vinculado ao SKU da fórmula.
  SELECT op.valor_unitario, op.ativo INTO v_base_preco, v_base_ativo
  FROM tint_formulas f
  LEFT JOIN tint_skus s ON s.id = f.sku_id
  LEFT JOIN omie_products op ON op.id = s.omie_product_id
  WHERE f.id = p_formula_id;

  -- Money-path: base inativa no Omie NÃO é vendável (produto descontinuado), mesmo
  -- com valor_unitario congelado > 0. COALESCE(...,false) = paridade VERBATIM com o batch
  -- e robustez se `ativo` virar nullable; produto ausente => v_base_preco NULL já barra
  -- (false AND <qualquer> = false na lógica de 3 valores).
  v_base_disponivel := v_base_preco IS NOT NULL AND v_base_preco > 0 AND COALESCE(v_base_ativo, false);
  v_custo_base := CASE WHEN v_base_disponivel THEN v_base_preco ELSE NULL END;

  -- Corantes: custo só quando o produto Omie do corante tem preço > 0, está ATIVO e
  -- o volume é válido. COALESCE(op.ativo,false): corante sem produto Omie (op NULL via
  -- LEFT JOIN) => indisponível (já barrado por valor=0, mas explícito).
  WITH calc AS (
    SELECT
      fi.ordem,
      COALESCE(c.descricao, '?') AS corante_descricao,
      fi.qtd_ml,
      (COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0) AS custo_disponivel,
      CASE WHEN COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN op.valor_unitario / c.volume_total_ml ELSE 0 END AS custo_por_ml,
      CASE WHEN COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN fi.qtd_ml * (op.valor_unitario / c.volume_total_ml) ELSE 0 END AS custo_item
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = p_formula_id
  )
  SELECT
    COALESCE(SUM(custo_item), 0),
    COALESCE(bool_and(custo_disponivel), false),  -- fórmula sem itens => receita faltando (fail closed), não base pura
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


-- Versão BATCH (paridade VERBATIM das regras money-path da single, incl. o gate de ativo).
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH bases AS (
    SELECT f.id AS formula_id,
           op.valor_unitario AS base_preco,
           (op.valor_unitario IS NOT NULL AND op.valor_unitario > 0 AND COALESCE(op.ativo, false)) AS base_disponivel
    FROM tint_formulas f
    LEFT JOIN tint_skus s ON s.id = f.sku_id
    LEFT JOIN omie_products op ON op.id = s.omie_product_id
    WHERE f.id = ANY(p_formula_ids)
  ),
  corantes AS (
    SELECT fi.formula_id,
           COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
                             THEN fi.qtd_ml * op.valor_unitario / c.volume_total_ml ELSE 0 END), 0) AS custo_corantes,
           COALESCE(bool_and(COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0), false) AS corantes_completos
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = ANY(p_formula_ids)
    GROUP BY fi.formula_id
  )
  SELECT COALESCE(jsonb_object_agg(b.formula_id, jsonb_build_object(
    'custoBase', CASE WHEN b.base_disponivel THEN b.base_preco ELSE NULL END,
    'baseDisponivel', b.base_disponivel,
    'custoCorantes', COALESCE(co.custo_corantes, 0),
    'corantesCompletos', COALESCE(co.corantes_completos, false),
    'precoFinal', CASE WHEN b.base_disponivel AND COALESCE(co.corantes_completos, false)
                       THEN b.base_preco + COALESCE(co.custo_corantes, 0) ELSE NULL END
  )), '{}'::jsonb)
  FROM bases b
  LEFT JOIN corantes co ON co.formula_id = b.formula_id;
$function$;

-- Mesmo escopo: só authenticated executa (não PUBLIC/anon). CREATE OR REPLACE preserva
-- a ACL; reafirmado por idempotência (espelha a migration 20260615210000).
REVOKE ALL ON FUNCTION public.get_tint_prices(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_prices(uuid[]) TO authenticated;
