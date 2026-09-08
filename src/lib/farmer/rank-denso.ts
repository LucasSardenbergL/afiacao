/**
 * Rank DENSO 1-based sobre um comparador — a peça que faz a ordem sobreviver à persistência.
 *
 * O motor calculava a ordem em memória e a jogava fora ao gravar: `farmer_recommendations` não
 * tinha coluna de rank, e a leitura desempatava por `affinity_score` → `updated_at` → `id`. Os
 * dois primeiros empatam (medido em prod, 07/09/2026: 183 de 183 pares up-sell), então quem
 * elegia era o `id` uuid v4. Persistir o rank é o que fecha esse caminho.
 *
 * ⚠️ DENSO e não posicional. Candidatos que o comparador não separa recebem o MESMO número.
 * Numerar 1, 2, 3 entre empatados apenas trocaria o ENDEREÇO do defeito: em vez de "vence o menor
 * uuid" passaria a ser "vence o menor índice do array" — e o array vem da varredura do catálogo,
 * que é ordenada por `id`. Mesmo sorteio, com um nome mais respeitável.
 *
 * ⚠️ O empate é derivado do PRÓPRIO comparador (`comparar(a, b) === 0`), nunca de um predicado
 * paralelo. Dois critérios de igualdade divergem no dia em que um dos dois muda, e a divergência
 * apareceria como eleição fabricada — o comparador diria "empataram" e o rank diria "este venceu".
 */
export function rankDenso<T>(itens: readonly T[], comparar: (a: T, b: T) => number): number[] {
  // Ordena ÍNDICES, não os itens: o chamador precisa dos ranks alinhados à entrada, e ordenar a
  // entrada perderia essa correspondência (além de mutar o array de quem chamou).
  const indices = itens.map((_, i) => i);
  indices.sort((x, y) => comparar(itens[x], itens[y]));

  const ranks = new Array<number>(itens.length);
  let rank = 0;
  for (let p = 0; p < indices.length; p++) {
    if (p === 0 || comparar(itens[indices[p - 1]], itens[indices[p]]) !== 0) rank++;
    ranks[indices[p]] = rank;
  }
  return ranks;
}
