// Seleciona itens de CROSS-SELL (complementares, NÃO recompra) pra camada "experimente também"
// da proposta. PURO/testável. Candidatos vêm do engine de recomendação (farmer_recommendations,
// product_id→omie_products), ranqueados por `lie`. Exclui o que o cliente já compra/recebe
// (cesta). Codex adiou pro pós-piloto — degrada honesto (vazio se sem rec).

export interface CrossSellCand {
  omie_codigo_produto: number;
  nome: string;
  /**
   * Score de ranking vindo de `farmer_recommendations.lie`; null → por último.
   *
   * O nome da COLUNA é histórico. Desde o FU4-F fase 3 ela guarda AFINIDADE (adimensional), não
   * "lucro incremental esperado": o custo saiu do browser, então o motor não calcula mais lucro.
   * Ordenar por ela segue correto — só não é ordenar por dinheiro. E as linhas anteriores ao
   * scrub (migration 20260725125000) vêm com `lie` NULL, que este seletor já joga para o fim.
   */
  lie: number | null;
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
