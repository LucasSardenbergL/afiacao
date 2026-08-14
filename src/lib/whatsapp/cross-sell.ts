// Seleciona itens de CROSS-SELL (complementares, NÃO recompra) pra camada "experimente também"
// da proposta. PURO/testável. Candidatos vêm do engine de recomendação (farmer_recommendations,
// product_id→omie_products), ranqueados por AFINIDADE. Exclui o que o cliente já compra/recebe
// (cesta). Codex adiou pro pós-piloto — degrada honesto (vazio se sem rec).

export interface CrossSellCand {
  omie_codigo_produto: number;
  nome: string;
  /**
   * Score de ranking vindo de `farmer_recommendations.affinity_score`; null → por último.
   *
   * ADIMENSIONAL, não dinheiro. Era `lie` (Lucro Incremental Esperado em R$), que o FU4-F fase 3
   * tirou de cena junto com `m_ij`: o custo saiu do browser, então o motor não calcula lucro — e o
   * valor monetário invertia sozinho para margem. Ordenar segue correto; só não é ordenar por R$.
   * Linhas gravadas antes da coluna existir vêm NULL, e este seletor já as joga para o fim.
   */
  afinidade: number | null;
}

export function selecionarCrossSell(cestaSkus: Set<number>, candidatos: CrossSellCand[], n: number): CrossSellCand[] {
  // dedupe por SKU mantendo o de maior afinidade; exclui o que já está na cesta
  const melhorPorSku = new Map<number, CrossSellCand>();
  for (const cand of candidatos) {
    if (cestaSkus.has(cand.omie_codigo_produto)) continue;
    const atual = melhorPorSku.get(cand.omie_codigo_produto);
    if (!atual || (cand.afinidade ?? -Infinity) > (atual.afinidade ?? -Infinity)) {
      melhorPorSku.set(cand.omie_codigo_produto, cand);
    }
  }
  return [...melhorPorSku.values()]
    .sort((a, b) => (b.afinidade ?? -Infinity) - (a.afinidade ?? -Infinity))
    .slice(0, Math.max(0, n));
}
