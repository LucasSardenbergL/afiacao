// Cálculo puro do preço de uma fórmula tintométrica (custo dos corantes).
// Espelha VERBATIM a lógica que vivia inline em `useTintPricing` — extraído para:
//  (a) tornar o money-path de preço testável (antes não era), e
//  (b) servir de oráculo de paridade para a futura RPC SQL `get_tint_price`
//      (hardening da receita; ver
//      docs/superpowers/specs/2026-05-27-tint-recipe-hardening-design.md).
// Qualquer mudança aqui muda o preço cobrado — alterar só com teste de paridade.

export interface TintCoranteItem {
  coranteDescricao: string;
  qtdMl: number;
  custoPorMl: number;
  custoItem: number;
  custoDisponivel: boolean;
}

export interface TintPriceBreakdown {
  custoBase: number;
  itensCorantes: TintCoranteItem[];
  custoCorantes: number;
  precoFinal: number;
}

/** Item da fórmula: quantidade de um corante (a "receita" — IP a proteger). */
export interface TintFormulaItemInput {
  qtd_ml: number;
  corante_id: string;
}

/** Corante e seu vínculo com o produto Omie (para custo). */
export interface TintCoranteInput {
  id: string;
  descricao: string;
  volume_total_ml: number | null;
  omie_product_id: string | null;
}

/** `valor_unitario` do produto Omie, indexado por `omie_product_id`. */
export type TintOmiePriceMap = Record<string, { valor_unitario: number }>;

/**
 * Custo dos corantes de uma fórmula = Σ (qtd_ml × valor_unitario / volume_total_ml).
 * `custoBase` é 0 (a base entra no preço fora deste cálculo, no consumidor).
 * `precoFinal` aqui = `custoCorantes` (idêntico ao comportamento original).
 */
export function computeTintPrice(
  items: TintFormulaItemInput[],
  corantes: TintCoranteInput[],
  omieProducts: TintOmiePriceMap,
): TintPriceBreakdown {
  const itensCorantes: TintCoranteItem[] = items.map((item) => {
    const corante = corantes.find((c) => c.id === item.corante_id);
    if (!corante) {
      return { coranteDescricao: '?', qtdMl: item.qtd_ml, custoPorMl: 0, custoItem: 0, custoDisponivel: false };
    }

    const omie = corante.omie_product_id ? omieProducts[corante.omie_product_id] : null;
    const custoDisponivel = !!omie && !!corante.volume_total_ml && corante.volume_total_ml > 0;
    const custoPorMl = custoDisponivel ? omie!.valor_unitario / corante.volume_total_ml! : 0;
    const custoItem = item.qtd_ml * custoPorMl;

    return {
      coranteDescricao: corante.descricao,
      qtdMl: item.qtd_ml,
      custoPorMl,
      custoItem,
      custoDisponivel,
    };
  });

  const custoCorantes = itensCorantes.reduce((sum, i) => sum + i.custoItem, 0);

  return { custoBase: 0, itensCorantes, custoCorantes, precoFinal: custoCorantes };
}
