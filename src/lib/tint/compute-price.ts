// Cálculo puro do preço de uma fórmula tintométrica: BASE (Omie) + Σ corantes.
// É o oráculo de paridade da RPC SQL `get_tint_price` (espelhada verbatim) — e o
// único ponto onde "preço calculado" é definido. Qualquer mudança aqui muda o
// preço cobrado: alterar só com teste de paridade (vitest + PG17 falsificável).
//
// Money-path (ausente ≠ zero): se a base não tem preço, OU se qualquer corante
// não tem custo, o `precoFinal` é NULL — nunca um número subfaturado. O consumidor
// mostra "sem preço" / "vincular no Omie", jamais R$ 0.

export interface TintCoranteItem {
  coranteDescricao: string;
  qtdMl: number;
  custoPorMl: number;
  custoItem: number;
  custoDisponivel: boolean;
}

export interface TintPriceBreakdown {
  /** Preço da base (valor_unitario Omie). NULL quando ausente/zero — nunca fabricar 0. */
  custoBase: number | null;
  /** A base tem preço utilizável (> 0)? */
  baseDisponivel: boolean;
  itensCorantes: TintCoranteItem[];
  /** Soma dos corantes COM custo (pode ser parcial — apenas para exibição). */
  custoCorantes: number;
  /** Todos os itens da fórmula têm custo disponível? */
  corantesCompletos: boolean;
  /** base + corantes; NULL se a base OU qualquer corante faltar (ausente ≠ zero). */
  precoFinal: number | null;
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
 * Preço de uma fórmula = base + Σ (qtd_ml × valor_unitario / volume_total_ml).
 * @param precoBase `valor_unitario` Omie da base (do SKU da fórmula); `null`/`<=0` = indisponível.
 *
 * `precoFinal` só é número quando a base existe E todos os corantes têm custo.
 * Senão é `null` (degradação honesta), enquanto `custoCorantes` ainda traz a
 * soma parcial para exibição.
 */
export function computeTintPrice(
  items: TintFormulaItemInput[],
  corantes: TintCoranteInput[],
  omieProducts: TintOmiePriceMap,
  precoBase: number | null,
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
  const corantesCompletos = itensCorantes.every((i) => i.custoDisponivel);

  const baseDisponivel = precoBase != null && precoBase > 0;
  const custoBase = baseDisponivel ? precoBase : null;
  const precoFinal = baseDisponivel && corantesCompletos ? custoBase! + custoCorantes : null;

  return { custoBase, baseDisponivel, itensCorantes, custoCorantes, corantesCompletos, precoFinal };
}
