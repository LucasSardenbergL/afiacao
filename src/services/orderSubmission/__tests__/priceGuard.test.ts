import { describe, it, expect } from 'vitest';
import {
  isInvalidProductPrice,
  findInvalidPricedProductItems,
  invalidPriceMessage,
} from '../priceGuard';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';

function prod(unit_price: number, descricao = 'Lixa'): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 1, unit_price,
    product: { id: 'p', omie_codigo_produto: 'X', codigo: 'C', descricao, unidade: 'UN' },
  } as unknown as ProductCartItem;
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
