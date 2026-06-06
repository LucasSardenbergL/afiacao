import { describe, it, expect } from 'vitest';
import { resolveCompanyForPrint, buildSalesOrderPrintRow, itemTotal } from '../print';
import { buildPrintData } from '@/components/sales/print/buildPrintHtml';
import type { SalesOrder } from '../types';

// Um pedido de venda como ele chega na listagem (select('*') + _source).
// Em runtime os itens trazem codigo/unidade/tint além de descricao/qtd/valores.
const baseOrder = (overrides: Partial<SalesOrder> = {}): SalesOrder =>
  ({
    id: 'ord-1',
    customer_user_id: 'user-1',
    items: [
      { codigo: 'PRD01', descricao: 'Verniz PU', quantidade: 2, unidade: 'GL', valor_unitario: 50, valor_total: 100 },
    ],
    subtotal: 100,
    total: 100,
    status: 'cancelado',
    omie_numero_pedido: '0000011104',
    omie_pedido_id: null,
    created_at: '2026-06-02T21:00:00Z',
    notes: 'obs teste',
    account: 'oben',
    customer_address: 'Rua X, 10 - Centro',
    customer_phone: '37999999999',
    _source: 'sales',
    ...overrides,
  }) as unknown as SalesOrder;

describe('resolveCompanyForPrint', () => {
  it('oben → oben', () => expect(resolveCompanyForPrint('oben')).toBe('oben'));
  it('colacor → colacor', () => expect(resolveCompanyForPrint('colacor')).toBe('colacor'));
  it('colacor_sc → afiacao (entidade Colacor S.C.)', () =>
    expect(resolveCompanyForPrint('colacor_sc')).toBe('afiacao'));
  it('undefined/desconhecido → oben (default)', () => {
    expect(resolveCompanyForPrint(undefined)).toBe('oben');
    expect(resolveCompanyForPrint('xpto')).toBe('oben');
  });
});

describe('itemTotal', () => {
  it('usa valor_total quando presente', () => {
    expect(itemTotal({ valor_total: 100, quantidade: 2, valor_unitario: 50 })).toBe(100);
  });
  it('calcula qtd × unit quando valor_total vem 0 (rascunho sem total gravado)', () => {
    expect(itemTotal({ valor_total: 0, quantidade: 2, valor_unitario: 50 })).toBe(100);
  });
  it('calcula qtd × unit quando valor_total ausente', () => {
    expect(itemTotal({ quantidade: 3, valor_unitario: 10 })).toBe(30);
  });
  it('zero quando não há dados', () => {
    expect(itemTotal({})).toBe(0);
  });
});

describe('buildSalesOrderPrintRow', () => {
  it('injeta nome e documento do cliente', () => {
    const row = buildSalesOrderPrintRow(baseOrder(), 'ACME LTDA', '12.345.678/0001-99');
    expect(row.customer_name).toBe('ACME LTDA');
    expect(row.customer_document).toBe('12.345.678/0001-99');
  });

  it('preserva os campos do item (codigo/unidade), não só descricao/qtd', () => {
    const row = buildSalesOrderPrintRow(baseOrder(), 'ACME', '');
    expect(row.items).toHaveLength(1);
    expect(row.items[0].codigo).toBe('PRD01');
    expect(row.items[0].unidade).toBe('GL');
    expect(row.items[0].valor_total).toBe(100);
  });

  it('traz endereço e telefone da linha do pedido', () => {
    const row = buildSalesOrderPrintRow(baseOrder(), 'ACME', '');
    expect(row.customer_address).toBe('Rua X, 10 - Centro');
    expect(row.customer_phone).toBe('37999999999');
  });

  it('preserva total/subtotal/account/PV/observações', () => {
    const row = buildSalesOrderPrintRow(baseOrder(), 'ACME', '');
    expect(row.total).toBe(100);
    expect(row.subtotal).toBe(100);
    expect(row.account).toBe('oben');
    expect(row.omie_numero_pedido).toBe('0000011104');
    expect(row.notes).toBe('obs teste');
  });

  it('preenche valor_total do item a partir de qtd × unit quando vem zerado (rascunho)', () => {
    const o = baseOrder({
      items: [{ descricao: 'X', quantidade: 2, valor_unitario: 50, valor_total: 0 }] as unknown as SalesOrder['items'],
    });
    const row = buildSalesOrderPrintRow(o, 'ACME', '');
    expect(row.items[0].valor_total).toBe(100);
  });

  it('degrada sem lançar quando items ausente e document omitido', () => {
    const row = buildSalesOrderPrintRow(baseOrder({ items: undefined as unknown as SalesOrder['items'] }), 'ACME');
    expect(row.items).toEqual([]);
    expect(row.customer_document).toBeUndefined();
  });
});

describe('integração com o pipeline de impressão real (buildPrintData)', () => {
  it('produz PrintOrderData fiel: empresa, cliente, codigo do item e nº do pedido', () => {
    const order = baseOrder({ account: 'colacor_sc' });
    const data = buildPrintData(
      buildSalesOrderPrintRow(order, 'ACME LTDA', '12.345.678/0001-99'),
      resolveCompanyForPrint(order.account),
    );
    expect(data.companyName).toBe('COLACOR S.C LTDA');
    expect(data.customerName).toBe('ACME LTDA');
    expect(data.customerDocument).toBe('12.345.678/0001-99');
    expect(data.items[0].codigo).toBe('PRD01');
    expect(data.items[0].unidade).toBe('GL');
    expect(data.orderNumber).toBe('11104'); // strip de zeros à esquerda
  });
});
