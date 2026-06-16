// Guard money-path da EDIÇÃO de pedido: nenhum item de produto pode ser salvo com
// valor_unitario <= 0. Espelha src/services/orderSubmission/priceGuard.ts (envio),
// mas sobre o shape OrderItem (valor_unitario + descricao no topo, não unit_price /
// product.descricao). Reusa a regra-núcleo isInvalidProductPrice (!(price > 0)).
import { describe, it, expect } from 'vitest';
import { invalidPricedOrderItemIndices, invalidOrderPriceMessage } from '../priceGuard';
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
