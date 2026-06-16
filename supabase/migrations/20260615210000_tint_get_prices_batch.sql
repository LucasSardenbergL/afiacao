-- Passo 1b do flip tintométrico: versão BATCH do preço honesto.
--
-- get_tint_price calcula 1 fórmula; as "outras embalagens" e a "busca global" do
-- balcão precisam de N preços de uma vez (uma cor em várias bases). N chamadas
-- single seria N round-trips; esta RPC resolve todas num query só e devolve um
-- mapa { "<formula_id>": breakdown }.
--
-- Espelha VERBATIM as regras money-path de get_tint_price (paridade com o oráculo
-- TS src/lib/tint/compute-price.ts):
--   * base: omie_products.valor_unitario do SKU da fórmula; baseDisponivel = NOT NULL e > 0.
--   * corantes: Σ (qtd_ml × valor_unitario / volume_total_ml); custo só quando
--     COALESCE(valor_unitario,0) > 0 E volume_total_ml > 0 (preço 0/negativo = inválido).
--   * corantesCompletos: bool_and dos itens; fórmula SEM itens => false (fail closed,
--     via COALESCE/LEFT JOIN ausente) — receita faltando NÃO é "base pura".
--   * precoFinal: base + corantes só quando base E corantes completos; senão NULL
--     (ausente != zero — nunca um número subfaturado).
--
-- NÃO devolve itensCorantes (a receita): as alternativas/busca global mostram só o
-- preço, então o agregado basta — e não há risco de vazar a receita (IP). Por isso
-- é SQL puro sem o gate de staff da single (o preço em si já é público na single).
-- Provado em db/test-tint-get-prices.sh (PG17 falsificável).

CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH bases AS (
    SELECT f.id AS formula_id,
           op.valor_unitario AS base_preco,
           (op.valor_unitario IS NOT NULL AND op.valor_unitario > 0) AS base_disponivel
    FROM tint_formulas f
    LEFT JOIN tint_skus s ON s.id = f.sku_id
    LEFT JOIN omie_products op ON op.id = s.omie_product_id
    WHERE f.id = ANY(p_formula_ids)
  ),
  corantes AS (
    SELECT fi.formula_id,
           COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0) > 0 AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
                             THEN fi.qtd_ml * op.valor_unitario / c.volume_total_ml ELSE 0 END), 0) AS custo_corantes,
           COALESCE(bool_and(COALESCE(op.valor_unitario,0) > 0 AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0), false) AS corantes_completos
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

-- Mesmo escopo da single get_tint_price: só authenticated executa (não PUBLIC/anon).
REVOKE ALL ON FUNCTION public.get_tint_prices(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_prices(uuid[]) TO authenticated;
