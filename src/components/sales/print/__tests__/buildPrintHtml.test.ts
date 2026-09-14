/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): este é um
 * `.ts` — logo, no ambiente `node` por padrão — mas toca DOM. O docblock sobrepõe o
 * project e é local ao arquivo, então não vira ímã de conflito entre worktrees.
 */
import { describe, it, expect } from 'vitest';
import { buildPrintData, buildSingleOrderHtml, buildPrintDocument } from '../buildPrintHtml';
import type { LeituraDescontosItens, LinhaDescontoItem } from '../descontoCupom';
import type { SalesOrderRow } from '../types';
import { formatPrecoOuAusente as fmt } from '@/lib/format';

const SEM_ORDER_ITEMS: LeituraDescontosItens = { estado: 'nao-se-aplica' };

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
    const data = buildPrintData(order, 'oben', undefined, SEM_ORDER_ITEMS);
    expect(data.companyName).toBe('OBEN COMÉRCIO LTDA');
    expect(data.isOben).toBe(true);
    expect(data.orderNumber).toBe('123');
    expect(data.customerName).toBe('João Cliente');
    expect(data.items).toHaveLength(1);
    expect(data.items[0].descricao).toBe('Produto Alpha');
    expect(data.total).toBe(20);
  });

  it('usa fallback de nome e logo por empresa', () => {
    const data = buildPrintData({ ...order, customer_name: undefined }, 'colacor', { colacor: 'http://logo' }, SEM_ORDER_ITEMS);
    expect(data.companyName).toBe('COLACOR COMERCIAL LTDA');
    expect(data.isOben).toBe(false);
    expect(data.customerName).toBe('Cliente');
    expect(data.companyLogoUrl).toBe('http://logo');
  });

  it('orderNumber cai para id quando sem omie_numero_pedido', () => {
    const data = buildPrintData({ ...order, omie_numero_pedido: null }, 'oben', undefined, SEM_ORDER_ITEMS);
    expect(data.orderNumber).toBe('ABC12345');
  });
});

describe('buildSingleOrderHtml', () => {
  it('inclui cabeçalho, cliente, item e total', () => {
    const html = buildSingleOrderHtml(buildPrintData(order, 'colacor', undefined, SEM_ORDER_ITEMS));
    expect(html).toContain('COLACOR COMERCIAL LTDA');
    expect(html).toContain('João Cliente');
    expect(html).toContain('Produto Alpha');
    expect(html).toContain('Nº 123');
  });

  it('inclui o recibo LGPD quando isOben', () => {
    const html = buildSingleOrderHtml(buildPrintData(order, 'oben', undefined, SEM_ORDER_ITEMS));
    expect(html).toContain('RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL');
  });

  it('gera parcelas a partir de condPagamento "28/42"', () => {
    const html = buildSingleOrderHtml(buildPrintData({ ...order, cond_pagamento: '28/42' }, 'colacor', undefined, SEM_ORDER_ITEMS));
    expect(html).toContain('1ª parcela');
    expect(html).toContain('2ª parcela');
    expect(html).toContain('CONDIÇÃO DE PAGAMENTO');
  });

  it('à vista (000) não gera parcelas', () => {
    const html = buildSingleOrderHtml(buildPrintData({ ...order, cond_pagamento: '000' }, 'colacor', undefined, SEM_ORDER_ITEMS));
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

// ── Desconto de item (order_items.desconto_valor) ──────────────────────────────────────────────
// Pedido real oben 12183048572: o jsonb `items` é BRUTO (a chave legado `desconto` é sempre 0) e o
// desconto de cada linha só existe em order_items. Com o cabeçalho líquido do #2469 as linhas
// somavam 1.629,25 sob um TOTAL de 1.489,34, sem nada no papel explicando os R$ 139,91.
const pedidoReal = (total: number): SalesOrderRow => ({
  id: '16b82610-2871-42b7-9fa4-9ba94d21dfb2',
  customer_user_id: 'u1',
  items: [
    { desconto: 0, descricao: 'BASE BRIL 20 FOSCO METALIZADA INTER WJOI.7666GL', quantidade: 1, valor_unitario: 460.25, omie_codigo_produto: 8689791246 },
    { desconto: 0, descricao: 'BASE BRIL 20 FOSCO BRANC WJOB.7585GL', quantidade: 2, valor_unitario: 584.5, omie_codigo_produto: 8689787325 },
  ],
  subtotal: total,
  total,
  status: 'importado',
  omie_numero_pedido: '12780',
  created_at: '2026-09-10T00:00:00+00:00',
  notes: null,
  customer_name: 'Cliente',
  customer_document: '',
});
const LINHAS: LinhaDescontoItem[] = [
  { omie_codigo_produto: 8689787325, quantity: 2, unit_price: 584.5, desconto_valor: 116.9 },
  { omie_codigo_produto: 8689791246, quantity: 1, unit_price: 460.25, desconto_valor: 23.01 },
];
const lida = (linhas: LinhaDescontoItem[] = LINHAS): LeituraDescontosItens => ({ estado: 'lida', linhas });

describe('buildPrintData — desconto de item a partir de order_items', () => {
  it('desconto fecha com o total: cada item leva o seu desconto e o LÍQUIDO da linha', () => {
    const data = buildPrintData(pedidoReal(1489.34), 'oben', undefined, lida());
    expect(data.items.map((i) => i.descontoValor)).toEqual([23.01, 116.9]);
    expect(data.items.map((i) => i.valorTotal)).toEqual([437.24, 1052.1]);
    expect(data.quebraDesconto).toEqual({ subtotalBruto: 1629.25, descontoTotal: 139.91, itensApurados: 2 });
    expect(data.total).toBe(1489.34);
    expect(data.avisoDesconto).toBeUndefined();
  });

  it('cabeçalho ainda bruto: dados do cupom idênticos aos de hoje, mais o aviso à equipe', () => {
    const { avisoDesconto, ...cupom } = buildPrintData(pedidoReal(1629.25), 'oben', undefined, lida());
    expect(cupom).toEqual(buildPrintData(pedidoReal(1629.25), 'oben', undefined, SEM_ORDER_ITEMS));
    expect(avisoDesconto).toMatch(/^Pedido 12780: .*139,91.*1\.629,25/);
  });

  it('leitura de order_items falhou: cupom de hoje com aviso de leitura', () => {
    const data = buildPrintData(pedidoReal(1489.34), 'oben', undefined, { estado: 'falhou' });
    expect(data.quebraDesconto).toBeUndefined();
    expect(data.avisoDesconto).toMatch(/^Pedido 12780: não foi possível ler o desconto/);
  });
});

describe('buildSingleOrderHtml — desconto de item no cupom em lote', () => {
  it('com quebra: coluna Desconto, líquido por linha e Subtotal bruto − Desconto = TOTAL', () => {
    const html = buildSingleOrderHtml(buildPrintData(pedidoReal(1489.34), 'oben', undefined, lida()));
    expect(html.match(/<th[ >]/g)).toHaveLength(8);
    expect(html).toContain('>Desconto</th>');
    expect(html).toContain(`>${fmt(23.01)}</td>`);
    expect(html).toContain(`>${fmt(437.24)}</td>`);
    expect(html).toContain(`<span>Subtotal:</span><span>${fmt(1629.25)}</span>`);
    expect(html).toContain(`<span>Desconto:</span><span>- ${fmt(139.91)}</span>`);
    expect(html).toContain(`<span>TOTAL:</span><span>${fmt(1489.34)}</span>`);
  });

  it('linha não apurada sai "—" no desconto e no total da linha, e o rótulo diz quantos itens', () => {
    const linhas = [LINHAS[0], { ...LINHAS[1], desconto_valor: null }];
    const html = buildSingleOrderHtml(buildPrintData(pedidoReal(1512.35), 'oben', undefined, lida(linhas)));
    expect(html).toContain('<span>Desconto (1 de 2 itens):</span>');
    expect(html.match(/>—<\/td>/g)).toHaveLength(2);
  });

  it('sem quebra: 7 colunas e o Subtotal do cabeçalho, como hoje', () => {
    const html = buildSingleOrderHtml(buildPrintData(pedidoReal(1629.25), 'oben', undefined, lida()));
    expect(html.match(/<th[ >]/g)).toHaveLength(7);
    expect(html).not.toContain('>Desconto</th>');
    expect(html).toContain(`<span>Subtotal:</span><span>${fmt(1629.25)}</span>`);
  });
});
