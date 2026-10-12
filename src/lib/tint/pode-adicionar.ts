// Regra ÚNICA de "esta cor pode entrar no pedido" — toda porta de confirmação de cor
// (card da cor selecionada, outras embalagens, busca global, entrada por cor, 1 toque
// das "Cores do cliente") passa por aqui. Uma segunda regra seria o caminho para um
// atalho vender com preço carregando, sem preço ou a R$ 0.

/** Preço final > 0 (Codex P2): desconto de 99,99% arredondava a R$ 0,00 e vendia.
 *  Não é teto de desconto — é "nunca R$ 0". */
export function precoVendavel(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/** Fail-closed: o motor ainda calculando, sem preço confiável ou preço final ≤ 0 ⇒ não adiciona. */
export function podeAdicionarCor(p: { precoCarregando: boolean; disponivel: boolean; precoFinal: number | null }): boolean {
  return !p.precoCarregando && p.disponivel && precoVendavel(p.precoFinal);
}

/** Desconto % sobre o preço da fonte, com o arredondamento ao centavo de sempre
 *  (`Math.round` — o gate espelha em float8, ver tintometrico.md §Fronteira do SUBMIT). */
export function aplicarDesconto(precoSemDesconto: number, discountPct: number): number {
  return discountPct > 0 ? Math.round(precoSemDesconto * (1 - discountPct / 100) * 100) / 100 : precoSemDesconto;
}
