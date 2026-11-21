/**
 * B4/B5 (rodada 2): a busca de produto mostrava R$ 0,00 para produto sem preço e "Est: 0" vermelho
 * para estoque NÃO informado. Ausente ≠ zero: preço ausente é "Sob consulta"; estoque ausente é
 * selo neutro "Est: —" (só estoque INFORMADO ≤ 0 fica vermelho).
 */
export function rotuloPrecoProduto(preco: number | null | undefined): string {
  if (preco === null || preco === undefined || !Number.isFinite(preco) || preco <= 0) return 'Sob consulta';
  return preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export type TomEstoque = 'disponivel' | 'zerado' | 'ausente';

export function seloEstoque(estoque: number | null | undefined): { texto: string; tom: TomEstoque } {
  if (estoque === null || estoque === undefined || !Number.isFinite(estoque)) return { texto: 'Est: —', tom: 'ausente' };
  return { texto: `Est: ${estoque}`, tom: estoque > 0 ? 'disponivel' : 'zerado' };
}
