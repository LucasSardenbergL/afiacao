import { describe, it, expect } from 'vitest';
import { itemDaOsParaImpressao, itensOuIlegivel } from '../types';

// Revisão /sales #27 (Codex): um jsonb ruim lançava dentro da query e tirava da folha o dia inteiro
// daquela origem; e a OS de afiação era lida com os nomes do pedido de venda.
describe('itensOuIlegivel', () => {
  it('lista legivel passa', () => {
    expect(itensOuIlegivel([{ descricao: 'X' }], 'f')).toStrictEqual({ items: [{ descricao: 'X' }] });
  });
  it('objeto no lugar da lista marca SO aquele pedido', () => {
    expect(itensOuIlegivel({} as never, 'f')).toStrictEqual({ items: [], itensIlegiveis: true });
  });
  it('item nao-objeto marca ilegivel', () => {
    expect(itensOuIlegivel([null] as never, 'f')).toStrictEqual({ items: [], itensIlegiveis: true });
  });
});

describe('itemDaOsParaImpressao', () => {
  it('OS valida vira descricao/quantidade/preco do cupom', () => {
    expect(itemDaOsParaImpressao({ category: 'Serra', quantity: 3, unitPrice: 10 })).toStrictEqual({
      descricao: 'Serra', quantidade: 3, valor_unitario: 10, valor_total: 30,
    });
  });
  it('preco de servico 0 e a orcar (null), a regua da criacao (#11)', () => {
    const it0 = itemDaOsParaImpressao({ name: 'Faca', quantity: 1, unitPrice: 0 });
    expect(it0.valor_unitario).toBeNull();
    expect(it0.valor_total).toBeNull();
  });
});
