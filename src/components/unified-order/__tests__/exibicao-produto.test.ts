import { describe, it, expect } from 'vitest';
import { rotuloPrecoProduto, seloEstoque } from '../exibicao-produto';

// B4/B5 (rodada 2): ausente ≠ zero na busca de produto.
describe('exibição de produto na busca', () => {
  it('B5: estoque NÃO informado é selo neutro "Est: —", não "Est: 0" vermelho', () => {
    expect(seloEstoque(null)).toEqual({ texto: 'Est: —', tom: 'ausente' });
    expect(seloEstoque(undefined)).toEqual({ texto: 'Est: —', tom: 'ausente' });
  });

  it('B5: estoque informado segue: 0 é zerado (vermelho), > 0 disponível', () => {
    expect(seloEstoque(0)).toEqual({ texto: 'Est: 0', tom: 'zerado' });
    expect(seloEstoque(12)).toEqual({ texto: 'Est: 12', tom: 'disponivel' });
  });

  it('B4: produto sem preço é "Sob consulta", nunca R$ 0,00', () => {
    expect(rotuloPrecoProduto(null)).toBe('Sob consulta');
    expect(rotuloPrecoProduto(0)).toBe('Sob consulta');
    expect(rotuloPrecoProduto(undefined)).toBe('Sob consulta');
    expect(rotuloPrecoProduto(12.5)).toMatch(/^R\$\s12,50$/);
  });
});
