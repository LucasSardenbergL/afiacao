import { describe, it, expect } from 'vitest';
import { assembleLinesEContexto, buildCrossSellCandidatos } from './proposta-preview-core';
import type { PreviewOrder, PreviewItem, PreviewRec, PreviewProdById } from './proposta-preview-core';

const CANCEL = new Set(['CANCELADO', 'EXCLUIDO']);
function ord(id: string, account: string, status: string, over: Partial<PreviewOrder> = {}): PreviewOrder {
  return { id, account, status, order_date_kpi: '2026-03-01', created_at: '2026-03-01T10:00:00Z', ...over };
}
function it_(sku: number | null, sales_order_id: string, qty = 2): PreviewItem {
  return { omie_codigo_produto: sku, quantity: qty, unit_price: 10, sales_order_id };
}

describe('assembleLinesEContexto (codex Risco 2: join/account/status)', () => {
  it('infere account predominante (mais pedidos); tie-break determinístico por nome', () => {
    const r = assembleLinesEContexto(
      [ord('1', 'oben', 'FAT'), ord('2', 'oben', 'FAT'), ord('3', 'colacor', 'FAT')],
      [it_(100, '1'), it_(100, '2'), it_(200, '3')], CANCEL);
    expect(r.account).toBe('oben');
  });
  it('order_date usa order_date_kpi; cai pro created_at quando kpi null', () => {
    const r = assembleLinesEContexto(
      [ord('1', 'oben', 'FAT', { order_date_kpi: '2026-02-10' }), ord('2', 'oben', 'FAT', { order_date_kpi: null, created_at: '2026-01-05T08:00:00Z' })],
      [it_(100, '1'), it_(100, '2')], CANCEL);
    expect(r.lines.find(l => l.order_date === '2026-02-10')).toBeTruthy();
    expect(r.lines.find(l => l.order_date === '2026-01-05')).toBeTruthy(); // fallback created_at
  });
  it('item com sales_order_id órfão (sem pedido) é descartado', () => {
    const r = assembleLinesEContexto([ord('1', 'oben', 'FAT')], [it_(100, '1'), it_(999, 'ZZZ')], CANCEL);
    expect(r.lines.map(l => l.omie_codigo_produto)).toEqual([100]);
  });
  it('item com SKU null é descartado', () => {
    const r = assembleLinesEContexto([ord('1', 'oben', 'FAT')], [it_(100, '1'), it_(null, '1')], CANCEL);
    expect(r.lines.length).toBe(1);
  });
  it('statusValidos exclui cancelamento; statusesVistos mostra todos', () => {
    const r = assembleLinesEContexto(
      [ord('1', 'oben', 'FATURADO'), ord('2', 'oben', 'CANCELADO')],
      [it_(100, '1'), it_(200, '2')], new Set(['CANCELADO']));
    expect(r.statusesVistos).toEqual(['CANCELADO', 'FATURADO']);
    expect(r.statusValidos).toEqual(['FATURADO']);
  });
  it('sem pedidos → vazio/null', () => {
    const r = assembleLinesEContexto([], [], CANCEL);
    expect(r.account).toBeNull();
    expect(r.lines).toEqual([]);
  });
});

describe('buildCrossSellCandidatos (codex Risco 2: rec→omie, ativo, órfão)', () => {
  const prods: PreviewProdById[] = [
    { id: 'uuid-a', omie_codigo_produto: 500, descricao: 'Verniz', ativo: true },
    { id: 'uuid-b', omie_codigo_produto: 600, descricao: 'Estopa', ativo: false }, // inativo
  ];
  function rec(pid: string | null, lie: number | null, status: string | null = null): PreviewRec {
    return { product_id: pid, lie, status };
  }
  it('mapeia product_id → omie e mantém só ativos', () => {
    const r = buildCrossSellCandidatos([rec('uuid-a', 50), rec('uuid-b', 90)], prods);
    expect(r.map(c => c.omie_codigo_produto)).toEqual([500]); // 600 inativo fora
    expect(r[0].nome).toBe('Verniz');
  });
  it('descarta rec órfã (product_id sem produto), rejeitada e null', () => {
    const r = buildCrossSellCandidatos(
      [rec('uuid-x', 10), rec('uuid-a', 20, 'rejected'), rec(null, 30)], prods);
    expect(r).toEqual([]);
  });
});
