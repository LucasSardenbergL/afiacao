// Escada de proveniência de custo (money-path) — fonte ÚNICA da verdade.
//
// ESPELHADO VERBATIM em supabase/functions/_shared/cost-ladder.ts (Deno não importa
// de src/). A paridade byte-a-byte é provada por costLadder.parity.test.ts — qualquer
// divergência entre os dois arquivos quebra o CI. Mantenha este arquivo SEM imports
// (TS puro) para o espelho permanecer idêntico.
//
// Contexto: PRODUCT_COST foi REMOVIDO da escada operacional. O motor antigo lia
// cost_price legado como "Priority 1: PRODUCT_COST" (conf 0.95); como cost_price era
// semeado com proxy, um custo inventado virava "real" após ~2 reprocessamentos
// (lavagem de proveniência). CMC é a única fonte de custo REAL hoje. PRODUCT_COST
// fica reservado para o dia em que existir um writer real auditável.

export type CostSource =
  | 'CMC'
  | 'FAMILY_MARGIN_PROXY'
  | 'DEFAULT_PROXY'
  | 'PRODUCT_COST'
  | 'UNKNOWN';

export interface CostLadderConfig {
  margemDefault: number;
  margemMin: number;
  margemMax: number;
}

export interface CostLadderInput {
  /** valor_unitario do produto. */
  price: number;
  /** CMC atual do inventory (Custo Médio Contábil do Omie). null/0 = ausente. */
  cmc: number | null;
  /** Margem média da família, calculada SÓ de custos REAIS pelo chamador. null se amostra insuficiente. */
  familyTargetMargin: number | null;
  cfg: CostLadderConfig;
}

export interface CostLadderResult {
  costFinal: number;
  costSource: CostSource;
  costConfidence: number;
  /** Valor a gravar em product_costs.cost_price. CMC real → o CMC; proxy → null (NUNCA semeia proxy). */
  costPriceToPersist: number | null;
}

export function computeCostLadder(input: CostLadderInput): CostLadderResult {
  const { price, cmc, familyTargetMargin, cfg } = input;
  const { margemDefault, margemMin, margemMax } = cfg;

  // Guard money-path na fronteira: preço inválido nunca fabrica custo.
  if (!(Number.isFinite(price) && price > 0)) {
    return { costFinal: 0, costSource: 'UNKNOWN', costConfidence: 0, costPriceToPersist: null };
  }

  // Sanidade do custo real: dentro da faixa de margem plausível (estrito nas bordas).
  // PENDÊNCIA conhecida: um CMC fora desta faixa (ex.: margem negativa real / venda no
  // prejuízo) é rejeitado e degrada para proxy — isso ESCONDE a margem ruim real. Tratar
  // numa entrega futura (tornar observável em vez de mascarar). Não regredir aqui.
  const sane = (c: number | null): c is number =>
    c != null &&
    Number.isFinite(c) &&
    c > 0 &&
    c < price * (1 - margemMin) &&
    c > price * (1 - margemMax);

  // Priority 1: CMC — ÚNICA fonte de custo REAL. Semeia cost_price com o CMC.
  if (sane(cmc)) {
    return { costFinal: cmc, costSource: 'CMC', costConfidence: 0.85, costPriceToPersist: cmc };
  }

  // Priority 2: proxy de família. Proxy NUNCA semeia cost_price.
  if (familyTargetMargin != null && familyTargetMargin > margemMin && familyTargetMargin < margemMax) {
    return {
      costFinal: price * (1 - familyTargetMargin),
      costSource: 'FAMILY_MARGIN_PROXY',
      costConfidence: 0.5,
      costPriceToPersist: null,
    };
  }

  // Priority 3: default proxy.
  return {
    costFinal: price * (1 - margemDefault),
    costSource: 'DEFAULT_PROXY',
    costConfidence: 0.25,
    costPriceToPersist: null,
  };
}

// CMC a usar: o atual do inventory se > 0; senão o último persistido se > 0; senão null.
// 0 do inventory significa "esta linha de posição não traz custo", NÃO "o custo é zero" —
// tratar 0 como ausente preserva o CMC real persistido em vez de rebaixar custo real a proxy
// (regressão que `inv?.cmc ?? existing?.cmc` introduzia: 0 ?? x === 0). Pego no Codex review.
export function cmcPreferido(
  atual: number | null | undefined,
  persistido: number | null | undefined,
): number | null {
  if (typeof atual === 'number' && atual > 0) return atual;
  if (typeof persistido === 'number' && persistido > 0) return persistido;
  return null;
}
