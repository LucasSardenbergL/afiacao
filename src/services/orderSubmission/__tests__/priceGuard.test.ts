import { describe, it, expect } from 'vitest';
import {
  isInvalidProductPrice,
  findInvalidPricedProductItems,
  invalidPriceMessage,
  findInvalidPricedOmieItems,
  invalidOmieItemPriceMessage,
} from '../priceGuard';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';

function prod(unit_price: number, descricao = 'Lixa'): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 1, unit_price,
    product: { id: 'p', omie_codigo_produto: 'X', codigo: 'C', descricao, unidade: 'UN' },
  } as unknown as ProductCartItem;
}

/** Shape PERSISTIDO de item (orçamento/pedido em sales_orders.items e payload do edge):
 * preço em `valor_unitario` (não `unit_price`) e nome em `descricao` (não `product.descricao`). */
function omieItem(valor_unitario: number, descricao = 'Lixa', omie_codigo_produto = 'SKU') {
  return { omie_codigo_produto, quantidade: 1, valor_unitario, descricao };
}

describe('isInvalidProductPrice', () => {
  it('zero é inválido', () => {
    expect(isInvalidProductPrice(0)).toBe(true);
  });
  it('negativo é inválido', () => {
    expect(isInvalidProductPrice(-5)).toBe(true);
  });
  it('NaN é inválido (parseFlot("") || 0 nunca chega aqui, mas defesa money-path)', () => {
    expect(isInvalidProductPrice(Number.NaN)).toBe(true);
  });
  it('Infinity é inválido (parseFloat("1e309") vira Infinity → não pode ir ao Omie)', () => {
    expect(isInvalidProductPrice(Number.POSITIVE_INFINITY)).toBe(true);
  });
  it('-Infinity é inválido', () => {
    expect(isInvalidProductPrice(Number.NEGATIVE_INFINITY)).toBe(true);
  });
  it('preço positivo é válido', () => {
    expect(isInvalidProductPrice(10)).toBe(false);
  });
  it('preço positivo pequeno (centavo) é válido', () => {
    expect(isInvalidProductPrice(0.01)).toBe(false);
  });
});

describe('findInvalidPricedProductItems', () => {
  it('retorna vazio quando todos os preços são positivos', () => {
    expect(findInvalidPricedProductItems([prod(10), prod(50)])).toEqual([]);
  });
  it('retorna apenas os itens com preço inválido', () => {
    const zero = prod(0, 'Zerado');
    const neg = prod(-1, 'Negativo');
    const ok = prod(10, 'Ok');
    const result = findInvalidPricedProductItems([ok, zero, neg]);
    expect(result).toEqual([zero, neg]);
  });
  it('lista vazia → vazio', () => {
    expect(findInvalidPricedProductItems([])).toEqual([]);
  });
});

describe('invalidPriceMessage', () => {
  it('lista as descrições dos itens inválidos na mensagem', () => {
    const msg = invalidPriceMessage([prod(0, 'Disco 7"'), prod(0, 'Lixa 120')]);
    expect(msg).toContain('Disco 7"');
    expect(msg).toContain('Lixa 120');
    expect(msg.toLowerCase()).toContain('preço');
  });
});

// ── Variante para o shape PERSISTIDO (valor_unitario) — usada na conversão de
// orçamento (SalesQuotes) e espelhada no edge omie-vendas-sync. Mesmo predicado
// money-path (isInvalidProductPrice), shape diferente do carrinho. ──
describe('findInvalidPricedOmieItems', () => {
  it('retorna vazio quando todos os preços são positivos', () => {
    expect(findInvalidPricedOmieItems([omieItem(10), omieItem(50)])).toEqual([]);
  });
  it('pega zero/negativo/NaN/Infinity, preservando a ordem original', () => {
    const ok = omieItem(10, 'Ok');
    const zero = omieItem(0, 'Zero');
    const neg = omieItem(-1, 'Neg');
    const nan = omieItem(Number.NaN, 'NaN');
    const inf = omieItem(Number.POSITIVE_INFINITY, 'Inf');
    expect(findInvalidPricedOmieItems([ok, zero, neg, nan, inf])).toEqual([zero, neg, nan, inf]);
  });
  it('lista vazia → vazio', () => {
    expect(findInvalidPricedOmieItems([])).toEqual([]);
  });
  it('trata valor_unitario ausente/null/string (JSONB legado) como inválido', () => {
    // Orçamento pré-existente (a "4ª via") pode ter valor_unitario corrompido no JSONB —
    // o cast `quote.items as QuoteItem[]` é cego. Number.isFinite NÃO coage, então
    // undefined/null/string caem como inválido (money-path: ausente ≠ zero).
    const itens = [
      { omie_codigo_produto: 'A', quantidade: 1, valor_unitario: undefined as unknown as number, descricao: 'sem preço' },
      { omie_codigo_produto: 'B', quantidade: 1, valor_unitario: null as unknown as number, descricao: 'null' },
      { omie_codigo_produto: 'C', quantidade: 1, valor_unitario: '10' as unknown as number, descricao: 'string' },
    ];
    expect(findInvalidPricedOmieItems(itens)).toEqual(itens);
  });
});

describe('invalidOmieItemPriceMessage', () => {
  it('cita as descrições dos itens inválidos', () => {
    const msg = invalidOmieItemPriceMessage([omieItem(0, 'Disco 7"'), omieItem(0, 'Lixa 120')]);
    expect(msg).toContain('Disco 7"');
    expect(msg).toContain('Lixa 120');
    expect(msg.toLowerCase()).toContain('preço');
  });
  it('cai pro código Omie quando falta descrição', () => {
    const msg = invalidOmieItemPriceMessage([{ omie_codigo_produto: 'SKU9', valor_unitario: 0 }]);
    expect(msg).toContain('SKU9');
  });
});
