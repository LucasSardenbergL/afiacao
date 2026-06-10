import { describe, it, expect } from 'vitest';
import { filterFeedRows, mapSalesDetail, mapAfiacaoDetail } from '../feed';
import type { OrderFeedRow } from '../types';

const row = (p: Partial<OrderFeedRow> = {}): OrderFeedRow => ({
  origin: 'sales',
  id: 'r1',
  created_at: '2026-06-02T21:00:00Z',
  account: 'oben',
  order_number: '0000123',
  omie_pedido_id: 9,
  customer_user_id: 'u1',
  customer_name: 'ACME LTDA',
  item_names: ['Verniz PU', 'Catalisador'],
  item_quantity: 3,
  status: 'enviado',
  subtotal: 100,
  total: 100,
  ...p,
});

const FIXTURE: OrderFeedRow[] = [
  row({ id: 'a', account: 'oben', customer_name: 'ACME LTDA' }),
  row({ id: 'b', account: 'colacor', customer_name: 'BETA M&amp;M MOVEIS', order_number: '0000777', total: 250.5 }),
  row({ id: 'c', account: 'colacor_sc', customer_name: 'GAMA SC' }),
  row({ id: 'd', origin: 'afiacao', account: 'colacor_sc', order_number: null, omie_pedido_id: null, customer_name: 'DELTA INTERIORES', item_names: ['Afiacao Serra'], item_quantity: 1 }),
];

describe('filterFeedRows — abas', () => {
  it('all → tudo', () => expect(filterFeedRows(FIXTURE, '', 'all')).toHaveLength(4));
  it('oben → só oben', () => {
    const r = filterFeedRows(FIXTURE, '', 'oben');
    expect(r.map((x) => x.id)).toEqual(['a']);
  });
  it('colacor_sc inclui sales SC E afiação (afiação opera sob SC)', () => {
    const r = filterFeedRows(FIXTURE, '', 'colacor_sc');
    expect(r.map((x) => x.id)).toEqual(['c', 'd']);
  });
});

describe('filterFeedRows — busca', () => {
  it('por nome do cliente (com decode de entidades HTML — &amp; vira &)', () => {
    expect(filterFeedRows(FIXTURE, 'm&m', 'all').map((x) => x.id)).toEqual(['b']);
  });
  it('por nº do pedido (PV)', () => {
    expect(filterFeedRows(FIXTURE, '0777', 'all').map((x) => x.id)).toEqual(['b']);
  });
  it('por item', () => {
    expect(filterFeedRows(FIXTURE, 'serra', 'all').map((x) => x.id)).toEqual(['d']);
  });
  it('por total', () => {
    expect(filterFeedRows(FIXTURE, '250.50', 'all').map((x) => x.id)).toEqual(['b']);
  });
  it('sem match → vazio', () => {
    expect(filterFeedRows(FIXTURE, 'xyzinexistente', 'all')).toHaveLength(0);
  });
  it('busca composta com aba', () => {
    expect(filterFeedRows(FIXTURE, 'delta', 'colacor_sc').map((x) => x.id)).toEqual(['d']);
    expect(filterFeedRows(FIXTURE, 'delta', 'oben')).toHaveLength(0);
  });
  it('row com campos null não quebra a busca', () => {
    const r = filterFeedRows([row({ customer_name: null, order_number: null, item_names: [] })], 'acme', 'all');
    expect(r).toHaveLength(0);
  });
});

describe('mapSalesDetail', () => {
  it('preserva a linha e marca _source=sales', () => {
    const raw = {
      id: 's1', customer_user_id: 'u1', account: 'colacor',
      items: [{ descricao: 'X', quantidade: 2, valor_unitario: 50, valor_total: 100, tint_cor_id: '1247', tint_nome_cor: 'AZUL' }],
      subtotal: 100, total: 100, status: 'enviado', omie_numero_pedido: '01', omie_pedido_id: 5,
      created_at: '2026-06-01T00:00:00Z', notes: 'n', customer_address: 'Rua X', customer_phone: '37 9',
    };
    const o = mapSalesDetail(raw as never);
    expect(o._source).toBe('sales');
    expect(o.items[0].tint_cor_id).toBe('1247');
    expect(o.customer_address).toBe('Rua X');
    expect(o.total).toBe(100);
  });
});

describe('mapAfiacaoDetail', () => {
  it('normaliza items (category||name, quantity default 1) e account colacor_sc', () => {
    const raw = {
      id: 'o1', user_id: 'u1', status: 'em_afiacao', subtotal: 0, total: 50,
      created_at: '2026-06-01T00:00:00Z', notes: null,
      items: [{ category: 'Afiacao Serra', quantity: 2, unitPrice: 25 }, { name: 'Faca', unitPrice: 10 }],
    };
    const o = mapAfiacaoDetail(raw as never);
    expect(o._source).toBe('afiacao');
    expect(o.account).toBe('colacor_sc');
    expect(o.customer_user_id).toBe('u1');
    expect(o.items).toEqual([
      { descricao: 'Afiacao Serra', quantidade: 2, valor_unitario: 25, valor_total: 50 },
      { descricao: 'Faca', quantidade: 1, valor_unitario: 10, valor_total: 10 },
    ]);
    expect(o.subtotal).toBe(50); // subtotal 0 → cai pro total
    expect(o.omie_numero_pedido).toBeNull();
  });
  it('items não-array não quebra', () => {
    const o = mapAfiacaoDetail({ id: 'o2', user_id: 'u1', status: 'x', subtotal: 0, total: 0, created_at: 'd', notes: null, items: {} } as never);
    expect(o.items).toEqual([]);
  });
});
