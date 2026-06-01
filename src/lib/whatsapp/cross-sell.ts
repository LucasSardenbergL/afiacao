// Seleciona itens de CROSS-SELL (complementares, NÃO recompra) pra camada "experimente também"
// da proposta. PURO/testável. Candidatos vêm do engine de recomendação (farmer_recommendations,
// product_id→omie_products), ranqueados por `lie` (lucro incremental esperado). Exclui o que o
// cliente já compra/recebe (cesta). Codex adiou pro pós-piloto — degrada honesto (vazio se sem rec).

export interface CrossSellCand {
  omie_codigo_produto: number;
  nome: string;
  lie: number | null; // lucro incremental esperado (rank); null → por último
}

export function selecionarCrossSell(cestaSkus: Set<number>, candidatos: CrossSellCand[], n: number): CrossSellCand[] {
  // dedupe por SKU mantendo o de maior lie; exclui o que já está na cesta
  const melhorPorSku = new Map<number, CrossSellCand>();
  for (const cand of candidatos) {
    if (cestaSkus.has(cand.omie_codigo_produto)) continue;
    const atual = melhorPorSku.get(cand.omie_codigo_produto);
    if (!atual || (cand.lie ?? -Infinity) > (atual.lie ?? -Infinity)) {
      melhorPorSku.set(cand.omie_codigo_produto, cand);
    }
  }
  return [...melhorPorSku.values()]
    .sort((a, b) => (b.lie ?? -Infinity) - (a.lie ?? -Infinity))
    .slice(0, Math.max(0, n));
}
