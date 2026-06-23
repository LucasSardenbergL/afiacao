// Contrato de custo dos motores de recomendação/auditoria (Codex P2 cost-final-ignorado; follow-up da
// spec do cockpit). FONTE ÚNICA da régua de custo de MARGEM FIRME (recommend + algorithm-a-audit):
// ausente ≠ R$0; proxy NÃO é custo de margem confiável → null. Módulo puro — espelhado VERBATIM nas
// edges Deno recommend/index.ts e algorithm-a-audit/index.ts (Deno não importa de src/).
//
// NÃO é a régua do cockpit de valor (edge fin-valor-cockpit/index.ts): aquele é SOURCE-BLIND (usa
// cost_final>0 de QUALQUER source, inclusive proxy) e COMPENSA rebaixando a confiança via
// custo_baixa_confianca_pct (#1003) — filosofia "computa-mas-degrada". Aqui é o oposto (precisão>recall):
// proxy → null, margem firme só com source REAL. Split INTENCIONAL — NÃO convergir (unificar reverteria o
// #1003 → mais cm/EVP null no cockpit). O antigo resíduo "convergir resolverCustoCockpit pós-merge #959"
// MORREU: #959 fechado SEM merge (núcleo absorvido pelo #1003); resolverCustoCockpit nunca existiu em código.

export type CostRow = {
  cost_price: number | null;
  cost_final: number | null;
  cost_source: string | null;
  cost_confidence: number | null;
};

// CMC_MARGEM_ATIPICA é CMC REAL fora da banda de margem comercial (prejuízo/baixa/alta) — custo real
// de confiança rebaixada. É REAL (propaga como custo): a margem ruim fica VISÍVEL, nunca mascarada por proxy.
const COST_SOURCES_REAIS = new Set(['PRODUCT_COST', 'CMC', 'CMC_MARGEM_ATIPICA']);
// CMC_UNIDADE_SUSPEITA é descasamento de unidade (cmc por m²/m vs price noutra unidade): o cost_final é
// proxy de família, NÃO custo real — fica fora de REAIS (sem margem exibida) mas conta como PROXY p/ ranking.
const COST_SOURCES_PROXY = new Set(['FAMILY_MARGIN_PROXY', 'DEFAULT_PROXY', 'CMC_UNIDADE_SUSPEITA']);

function finitePositive(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function normalizarSource(source: string | null | undefined): string | null {
  const s = source?.trim().toUpperCase();
  return s ? s : null;
}

// Custo de MARGEM (exibido/logado). Ausente → null (NÃO fabrica margem).
//   1. source∈REAIS e finitePositive(cost_final)         → cost_final (vivo, preferido)
//   2. source∈{CMC,CMC_MARGEM_ATIPICA} e finitePositive(cost_price) → cost_price (fallback CMC-derivado)
//   3. resto (PROXY/UNKNOWN/null/fonte nova)              → null
export function resolverCustoConfiavel(row: CostRow | null | undefined): number | null {
  const source = normalizarSource(row?.cost_source);
  if (row == null || source == null || !COST_SOURCES_REAIS.has(source)) return null;
  if (finitePositive(row.cost_final)) return row.cost_final;
  if ((source === 'CMC' || source === 'CMC_MARGEM_ATIPICA') && finitePositive(row.cost_price)) return row.cost_price;
  return null;
}

// Custo de RANKING (só EIP/score; NUNCA exibido/logado como margem firme). Aceita estimativa proxy
// sanity-bounded (< price → margem estimada positiva). real ?? proxy cost_final válido ?? null.
export function estimarCustoParaRanking(row: CostRow | null | undefined, price: number): number | null {
  const real = resolverCustoConfiavel(row);
  if (real != null) return real;
  const source = normalizarSource(row?.cost_source);
  const cf = row?.cost_final ?? null;
  if (source != null && COST_SOURCES_PROXY.has(source) && finitePositive(cf) && cf < price) return cf;
  return null;
}

export type MargensCandidato = {
  custoConfiavel: number | null;
  custoRanking: number | null;
  margemExibida: number | null;
  margemRanking: number | null;
};

// Split por candidato (recommend). Helper HONESTO (null); o motor aplica o neutro (eip = margemRanking ?? 0).
export function derivarMargensCandidato(row: CostRow | null | undefined, price: number): MargensCandidato {
  const custoConfiavel = resolverCustoConfiavel(row);
  const custoRanking = estimarCustoParaRanking(row, price);
  return {
    custoConfiavel,
    custoRanking,
    margemExibida: custoConfiavel != null ? price - custoConfiavel : null,
    margemRanking: custoRanking != null ? price - custoRanking : null,
  };
}
