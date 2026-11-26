// Guard money-path da EDIÇÃO de pedido: nenhum item de produto pode ser salvo com
// valor_unitario <= 0. Espelha src/services/orderSubmission/priceGuard.ts (envio),
// mas sobre o shape OrderItem (valor_unitario + descricao no topo, não unit_price /
// product.descricao). Reusa a regra-núcleo isInvalidProductPrice (!(price > 0)).
import { describe, it, expect } from 'vitest';
import {
  invalidPricedOrderItemIndices, invalidOrderPriceMessage, invalidQuantityOrderItemIndices, lerDecimalPtBr, subtotalDaEdicao,
} from '../priceGuard';
import type { OrderItem } from '../types';

function item(valor_unitario: number, descricao = 'Lixa'): OrderItem {
  return { omie_codigo_produto: 1, descricao, quantidade: 1, valor_unitario, valor_total: valor_unitario };
}

describe('invalidPricedOrderItemIndices', () => {
  it('vazio quando todos os preços são positivos', () => {
    expect(invalidPricedOrderItemIndices([item(10), item(50)])).toEqual([]);
  });
  it('retorna os índices dos itens com preço inválido, preservando a ordem', () => {
    const result = invalidPricedOrderItemIndices([item(10, 'Ok'), item(0, 'Zerado'), item(-1, 'Negativo')]);
    expect(result).toEqual([1, 2]);
  });
  it('zero (campo esvaziado vira Number("") || 0) é inválido', () => {
    expect(invalidPricedOrderItemIndices([item(0)])).toEqual([0]);
  });
  it('NaN é inválido (defesa money-path)', () => {
    expect(invalidPricedOrderItemIndices([item(10), item(Number.NaN)])).toEqual([1]);
  });
  it('centavo (0.01) é válido', () => {
    expect(invalidPricedOrderItemIndices([item(0.01)])).toEqual([]);
  });
  it('lista vazia → vazio', () => {
    expect(invalidPricedOrderItemIndices([])).toEqual([]);
  });
});

describe('invalidOrderPriceMessage', () => {
  it('cita as descrições dos itens inválidos e pede preço maior que zero', () => {
    const msg = invalidOrderPriceMessage([item(0, 'Disco 7"'), item(0, 'Lixa 120')]);
    expect(msg).toContain('Disco 7"');
    expect(msg).toContain('Lixa 120');
    expect(msg.toLowerCase()).toContain('maior que zero');
  });
  it('usa o código quando a descrição está vazia', () => {
    const semDesc: OrderItem = { omie_codigo_produto: 9, codigo: 'COD-9', descricao: '', quantidade: 1, valor_unitario: 0, valor_total: 0 };
    expect(invalidOrderPriceMessage([semDesc])).toContain('COD-9');
  });
});

describe('lerDecimalPtBr', () => {
  it.each([
    ['12', 12], ['12,5', 12.5], ['12.5', 12.5], ['1.234,56', 1234.56], ['12,', 12], ['12.', 12],
    [' 7 ', 7], ['0', 0], [',5', 0.5], ['1.234.567,8', 1234567.8], ['1234', 1234],
  ])('%s → %s', (texto, n) => expect(lerDecimalPtBr(texto)).toBe(n));
  // Codex: '1,250.00' virava 1,25 (planilha em inglês); '12.5,0' virava 125; '1.234' é ambíguo.
  it.each(['', '  ', 'abc', '-3', '1e3', '12,5,3', 'Infinity', '1,250.00', '12.5,0', '1.234', '1.250', ',', 'R$ 12,50'])('%j → null (não lê, não inventa)', (texto) =>
    expect(lerDecimalPtBr(texto)).toBeNull());
});

describe('invalidQuantityOrderItemIndices', () => {
  const comQtd = (quantidade: number) => ({ ...item(10), quantidade });
  it('recusa 0, negativo e NaN; aceita positivo (inclusive fracionado)', () => {
    expect(invalidQuantityOrderItemIndices([comQtd(2), comQtd(0), comQtd(-1), comQtd(Number.NaN), comQtd(0.5)])).toEqual([1, 2, 3]);
  });
});

describe('subtotalDaEdicao — ausente ≠ zero', () => {
  it('linha SEM valor_total vale quantidade × preço (não 0)', () => {
    const semTotal = { ...item(50), quantidade: 2 } as OrderItem;
    delete semTotal.valor_total;
    expect(subtotalDaEdicao([semTotal])).toBe(100);
  });
  it('valor_total presente manda', () => {
    expect(subtotalDaEdicao([{ ...item(50), quantidade: 2, valor_total: 90 }])).toBe(90);
  });
  it('linha sem total apurável (preço null) → null, nunca um subtotal menor', () => {
    const semPreco = { ...item(50), valor_unitario: null, valor_total: null } as OrderItem;
    expect(subtotalDaEdicao([{ ...item(50), valor_total: 50 }, semPreco])).toBeNull();
  });
  it('centavo por linha: 2 × (0,5 × 2,01) = 2,02 (regra de crédito do envio)', () => {
    const l = { ...item(2.01), quantidade: 0.5 } as OrderItem;
    delete l.valor_total;
    expect(subtotalDaEdicao([l, { ...l }])).toBe(2.02);
    // Mesmos casos do teste da edge (`centavos`): 1,005 → 1,01 e 2,675 → 2,68.
    expect(subtotalDaEdicao([{ ...item(1.005), valor_total: 1.005 }])).toBe(1.01);
    expect(subtotalDaEdicao([{ ...item(2.675), valor_total: 2.675 }])).toBe(2.68);
  });
  it('soma que estoura para Infinity → null, nunca um subtotal que serializa null', () => {
    expect(subtotalDaEdicao([{ ...item(1e308), valor_total: 1e308 }, { ...item(1e308), valor_total: 1e308 }])).toBeNull();
  });
  it('quantidade NaN sem valor_total → null', () => {
    const r = { ...item(50), quantidade: Number.NaN } as OrderItem;
    delete r.valor_total;
    expect(subtotalDaEdicao([r])).toBeNull();
  });
});
