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

/** `valor_unitario` + status `ativo` do produto Omie, indexado por `omie_product_id`.
 *  `ativo` omitido = tratado como ativo (default da coluna omie_products.ativo é `true`). */
export type TintOmiePriceMap = Record<string, { valor_unitario: number; ativo?: boolean }>;

/**
 * Preço de uma fórmula = base + Σ (qtd_ml × valor_unitario / volume_total_ml).
 * @param precoBase `valor_unitario` Omie da base (do SKU da fórmula); `null`/`<=0` = indisponível.
 * @param baseAtiva a base está ATIVA no Omie? `false` = produto descontinuado → indisponível,
 *   mesmo com preço > 0. Espelha o gate de ativo da RPC get_tint_price (não vender produto
 *   que a empresa desativou no Omie). Default `true` para compat dos testes legados.
 *
 * `precoFinal` só é número quando a base existe E está ATIVA E todos os corantes têm custo E
 * estão ATIVOS. Senão é `null` (degradação honesta), enquanto `custoCorantes` ainda traz a soma
 * parcial para exibição. Oráculo de paridade da RPC — manter o gate de ativo sincronizado aqui.
 */
export function computeTintPrice(
  items: TintFormulaItemInput[],
  corantes: TintCoranteInput[],
  omieProducts: TintOmiePriceMap,
  precoBase: number | null,
  baseAtiva: boolean = true,
): TintPriceBreakdown {
  const itensCorantes: TintCoranteItem[] = items.map((item) => {
    const corante = corantes.find((c) => c.id === item.corante_id);
    if (!corante) {
      return { coranteDescricao: '?', qtdMl: item.qtd_ml, custoPorMl: 0, custoItem: 0, custoDisponivel: false };
    }

    const omie = corante.omie_product_id ? omieProducts[corante.omie_product_id] : null;
    // valor_unitario > 0 (não só presente): preço 0/negativo é dado inválido, não custo real.
    // omie.ativo !== false: corante desativado no Omie tem custo suspeito → indisponível (gate de ativo).
    const custoDisponivel = !!omie && omie.valor_unitario > 0 && omie.ativo !== false && !!corante.volume_total_ml && corante.volume_total_ml > 0;
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
  // length > 0: fórmula sem itens é receita faltando (dado incompleto), não "completa".
  // Cobrar só a base subfaturaria (confirmado em prod). Fail closed → precoFinal null.
  const corantesCompletos = itensCorantes.length > 0 && itensCorantes.every((i) => i.custoDisponivel);

  const baseDisponivel = precoBase != null && precoBase > 0 && baseAtiva;
  const custoBase = baseDisponivel ? precoBase : null;
  const precoFinal = baseDisponivel && corantesCompletos ? custoBase! + custoCorantes : null;

  return { custoBase, baseDisponivel, itensCorantes, custoCorantes, corantesCompletos, precoFinal };
}
