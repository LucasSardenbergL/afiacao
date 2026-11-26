import { describe, it, expect } from 'vitest';
import { mesmosItens, valoresDaEdicaoLocal } from '../edicaoLocal';
import type { OrderItem } from '../types';

const item = (over: Partial<OrderItem> = {}): OrderItem => ({
  product_id: 'p1', omie_codigo_produto: 111, codigo: 'A', descricao: 'Lixa', unidade: 'UN',
  quantidade: 2, valor_unitario: 10, valor_total: 20, ...over,
});

describe('valoresDaEdicaoLocal — pedido sem PV', () => {
  it('salvar só observação: NÃO toca items/subtotal/total (o líquido com desconto fica)', () => {
    const r = valoresDaEdicaoLocal({
      itensOriginais: [item()], itensNovos: [item()], subtotalOriginal: 20, totalOriginal: 15, subtotalNovo: 20,
    });
    expect(r).toEqual({ ok: true, valores: null });
  });

  it('valor_total recalculado na tela não conta como mudança de item', () => {
    expect(mesmosItens([item({ valor_total: 0 })], [item({ valor_total: 20 })])).toBe(true);
  });

  it('itens mudaram sem ajuste no cabeçalho: total = subtotal novo', () => {
    const r = valoresDaEdicaoLocal({
      itensOriginais: [item()], itensNovos: [item({ quantidade: 3, valor_total: 30 })],
      subtotalOriginal: 20, totalOriginal: 20, subtotalNovo: 30,
    });
    expect(r).toEqual({ ok: true, valores: { items: [item({ quantidade: 3, valor_total: 30 })], subtotal: 30, total: 30 } });
  });

  it('itens mudaram COM desconto/frete no cabeçalho: recusa (não escolhe entre R$ fixo e %)', () => {
    const r = valoresDaEdicaoLocal({
      itensOriginais: [item()], itensNovos: [item({ quantidade: 3 })],
      subtotalOriginal: 20, totalOriginal: 18, subtotalNovo: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('desconto ou frete no total');
  });

  it('total gravado ilegível com itens mudados: recusa', () => {
    const r = valoresDaEdicaoLocal({
      itensOriginais: [item()], itensNovos: [item({ quantidade: 3 })],
      subtotalOriginal: 20, totalOriginal: null, subtotalNovo: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('ilegível');
  });

  it('subtotal novo indeterminado com itens mudados: recusa', () => {
    const r = valoresDaEdicaoLocal({
      itensOriginais: [item()], itensNovos: [item({ valor_unitario: null })],
      subtotalOriginal: 20, totalOriginal: 20, subtotalNovo: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('Não consegui calcular');
  });

  it('reordenar ou trocar a cor de tinta é mudança de item', () => {
    expect(mesmosItens([item(), item({ omie_codigo_produto: 222 })], [item({ omie_codigo_produto: 222 }), item()])).toBe(false);
    expect(mesmosItens([item({ tint_cor_id: 'RAL1' })], [item({ tint_cor_id: 'RAL2' })])).toBe(false);
  });
});
