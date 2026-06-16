import { describe, it, expect } from 'vitest';
import { buildPrintData, buildSingleOrderHtml, buildPrintDocument } from '../buildPrintHtml';
import type { SalesOrderRow } from '../types';

const order: SalesOrderRow = {
  id: 'abc12345-9999',
  customer_user_id: 'u1',
  items: [
    { codigo: 'P1', descricao: 'Produto Alpha', quantidade: 2, unidade: 'UN', valor_unitario: 10, valor_total: 20 },
  ],
  subtotal: 20,
  total: 20,
  status: 'aprovado',
  omie_numero_pedido: '000123',
  created_at: '2026-01-15T10:00:00',
  notes: null,
  customer_name: 'João Cliente',
  customer_document: '123',
};

describe('buildPrintData', () => {
  it('mapeia pedido para PrintOrderData (oben) com número sem zeros à esquerda', () => {
    const data = buildPrintData(order, 'oben');
    expect(data.companyName).toBe('OBEN COMÉRCIO LTDA');
    expect(data.isOben).toBe(true);
    expect(data.orderNumber).toBe('123');
    expect(data.customerName).toBe('João Cliente');
    expect(data.items).toHaveLength(1);
    expect(data.items[0].descricao).toBe('Produto Alpha');
    expect(data.total).toBe(20);
  });

  it('usa fallback de nome e logo por empresa', () => {
    const data = buildPrintData({ ...order, customer_name: undefined }, 'colacor', { colacor: 'http://logo' });
    expect(data.companyName).toBe('COLACOR COMERCIAL LTDA');
    expect(data.isOben).toBe(false);
    expect(data.customerName).toBe('Cliente');
    expect(data.companyLogoUrl).toBe('http://logo');
  });

  it('orderNumber cai para id quando sem omie_numero_pedido', () => {
    const data = buildPrintData({ ...order, omie_numero_pedido: null }, 'oben');
    expect(data.orderNumber).toBe('ABC12345');
  });
});

describe('buildSingleOrderHtml', () => {
  it('inclui cabeçalho, cliente, item e total', () => {
    const html = buildSingleOrderHtml(buildPrintData(order, 'colacor'));
    expect(html).toContain('COLACOR COMERCIAL LTDA');
    expect(html).toContain('João Cliente');
    expect(html).toContain('Produto Alpha');
    expect(html).toContain('Nº 123');
  });

  it('inclui o recibo LGPD quando isOben', () => {
    const html = buildSingleOrderHtml(buildPrintData(order, 'oben'));
    expect(html).toContain('RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL');
  });

  it('gera parcelas a partir de condPagamento "28/42"', () => {
    const html = buildSingleOrderHtml(buildPrintData({ ...order, cond_pagamento: '28/42' }, 'colacor'));
    expect(html).toContain('1ª parcela');
    expect(html).toContain('2ª parcela');
    expect(html).toContain('CONDIÇÃO DE PAGAMENTO');
  });

  it('à vista (000) não gera parcelas', () => {
    const html = buildSingleOrderHtml(buildPrintData({ ...order, cond_pagamento: '000' }, 'colacor'));
    expect(html).not.toContain('1ª parcela');
  });
});

describe('buildPrintDocument', () => {
  it('envolve páginas com DOCTYPE, título com data, page-break e script de impressão', () => {
    const html = buildPrintDocument(['<div>A</div>', '<div>B</div>'], '15/01/2026');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('Impressão de Pedidos - 15/01/2026');
    expect(html).toContain('<div>A</div>');
    expect(html).toContain('<div class="page-break"></div>');
    expect(html).toContain('window.print()');
  });
});
