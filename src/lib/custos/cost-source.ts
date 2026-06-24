// Contrato de custo do money-path — fonte única. DUAS réguas do split INTENCIONAL (NÃO unificar — unificar
// reverteria o #1003: mais cm/EVP null no cockpit). Coincidem nas linhas reais (PRODUCT_COST/CMC), DIVERGEM
// em proxy:
//  • resolverCustoConfiavel (recommend + algorithm-a-audit): precisão>recall — proxy → null; ausente ≠ R$0;
//    margem firme só com source REAL.
//  • resolverCustoCockpit (cockpit A3, edge fin-valor-cockpit / #1003): "computa-e-degrada" — exibe a margem
//    mesmo de proxy, mas marca baixaConfianca (rebaixa o nível de confiança, NÃO esconde a linha). A cláusula
//    de source blinda o invariante latente que o #1010 rastreou: antes o cockpit confiava só no dado
//    "proxy⟹cost_confidence<0,7"; agora um proxy carimbado com conf>=0,7 NÃO vira margem firme silenciosa.
// Módulo puro — espelhado VERBATIM nas edges Deno recommend/index.ts e algorithm-a-audit/index.ts
// (resolverCustoConfiavel) e fin-valor-cockpit/index.ts (resolverCustoCockpit). Provado por __tests__/cost-source.test.ts.

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

export type CustoCockpit = {
  custo: number | null;       // custo de margem EXIBIDO; null = sem custo (cm vira null no combo)
  baixaConfianca: boolean;    // base estimada (fallback legado / source não-real / conf<0.7) — degrada, não nulifica
  legadoFallback: boolean;    // custo veio de cost_price (cost_final ausente/inválido) — alimenta o warn de cobertura
};

// Régua de custo do COCKPIT de valor (A3). DIFERENTE de resolverCustoConfiavel (recommend/audit, que NULIFICA
// proxy): o cockpit COMPUTA-E-DEGRADA (#1003) — exibe a margem mesmo de proxy e marca baixaConfianca p/ rebaixar
// o nível de confiança (custo_baixa_confianca_pct). Split INTENCIONAL, não unificar. Espelhada VERBATIM no edge
// fin-valor-cockpit/index.ts. custo: cost_final>0 (canônico) ?? cost_price>0 (fallback legado); null nos dois → sem
// custo. baixaConfianca: fallback legado OU source não-real OU cost_confidence<0.7.
export function resolverCustoCockpit(row: CostRow | null | undefined): CustoCockpit {
  const cf = row?.cost_final ?? null;
  const cp = row?.cost_price ?? null;
  const canonico = finitePositive(cf) ? cf : null;
  const custo = canonico ?? (finitePositive(cp) ? cp : null);
  if (custo == null) return { custo: null, baixaConfianca: false, legadoFallback: false };
  const legadoFallback = canonico == null;
  const source = normalizarSource(row?.cost_source);
  const sourceReal = source != null && COST_SOURCES_REAIS.has(source); // espelha o gate de resolverCustoConfiavel
  const conf = row?.cost_confidence ?? null;
  const confAlta = typeof conf === 'number' && conf >= 0.7;
  return { custo, baixaConfianca: legadoFallback || !sourceReal || !confAlta, legadoFallback };
}
