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
//
// CMC_MARGEM_ATIPICA: um CMC REAL fora da banda de margem plausível (prejuízo / margem
// baixa / margem alta) NÃO é mascarado por um proxy "bonito" (era a pendência (b) do #977,
// que ESCONDIA o prejuízo real). A banda de margem só CLASSIFICA (CMC normal vs atípico);
// a única REJEIÇÃO é o anti-lixo absoluto (custo quase-zero ou desproporcional = erro de dado).

export type CostSource =
  | 'CMC'
  | 'CMC_MARGEM_ATIPICA'
  | 'FAMILY_MARGIN_PROXY'
  | 'DEFAULT_PROXY'
  | 'PRODUCT_COST'
  | 'UNKNOWN';

export interface CostLadderConfig {
  margemDefault: number;
  margemMin: number;
  margemMax: number;
  /** Razão cmc/price MÍNIMA aceita como custo real (anti-lixo: abaixo disso é custo quase-zero / erro de dado). */
  cmcRatioMin: number;
  /** Razão cmc/price MÁXIMA aceita como custo real (anti-lixo: acima disso é custo desproporcional / erro de dado). */
  cmcRatioMax: number;
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
  /** Valor a gravar em product_costs.cost_price. CMC/CMC_MARGEM_ATIPICA real → o CMC; proxy → null (NUNCA semeia proxy). */
  costPriceToPersist: number | null;
}

export function computeCostLadder(input: CostLadderInput): CostLadderResult {
  const { price, cmc, familyTargetMargin, cfg } = input;
  const { margemDefault, margemMin, margemMax, cmcRatioMin, cmcRatioMax } = cfg;

  // Guard money-path na fronteira: preço inválido nunca fabrica custo.
  if (!(Number.isFinite(price) && price > 0)) {
    return { costFinal: 0, costSource: 'UNKNOWN', costConfidence: 0, costPriceToPersist: null };
  }

  // CMC real e utilizável? O guard rejeita SÓ lixo de dado: custo quase-zero ou desproporcional
  // ao preço (faixa anti-lixo ABSOLUTA e larga: price*cmcRatioMin..price*cmcRatioMax, inclusiva).
  // Um CMC que implica margem ruim REAL (prejuízo/baixa/alta) NÃO é lixo — é sinal de negócio.
  const cmcReal =
    cmc != null && Number.isFinite(cmc) && cmc > 0 &&
    cmc >= price * cmcRatioMin && cmc <= price * cmcRatioMax;

  if (cmcReal) {
    // Banda de margem plausível (estrito nas bordas) → CMC normal, alta confiança.
    // Fora da banda mas dentro do anti-lixo → CMC real de margem ATÍPICA (prejuízo/baixa/alta):
    // preserva o custo real (cost_final = cost_price = cmc) com confiança rebaixada e proveniência
    // distinta — observável e auditável, NUNCA trocado por um proxy "bonito" (fecha a pendência (b)).
    const dentroBanda = cmc < price * (1 - margemMin) && cmc > price * (1 - margemMax);
    return dentroBanda
      ? { costFinal: cmc, costSource: 'CMC', costConfidence: 0.85, costPriceToPersist: cmc }
      : { costFinal: cmc, costSource: 'CMC_MARGEM_ATIPICA', costConfidence: 0.6, costPriceToPersist: cmc };
  }

  // Sem CMC real (ausente / zero / lixo absoluto) → proxy honesto. Proxy NUNCA semeia cost_price.
  // Priority 2: proxy de família.
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
