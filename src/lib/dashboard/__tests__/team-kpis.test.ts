import { describe, it, expect } from 'vitest';
import { isPedidoValido, somarReceita, contarAtivos, type OrderRow, type AtividadeRow } from '../team-kpis';

describe('team-kpis', () => {
  it('isPedidoValido: cancelado/rascunho/null inválidos, resto válido', () => {
    expect(isPedidoValido('enviado')).toBe(true);
    expect(isPedidoValido('faturado')).toBe(true);
    expect(isPedidoValido('entregue')).toBe(true);
    expect(isPedidoValido('cancelado')).toBe(false);
    expect(isPedidoValido('rascunho')).toBe(false);
    expect(isPedidoValido(null)).toBe(false);
  });

  it('somarReceita: só pedidos válidos com order_date_kpi na janela [de, ate)', () => {
    const orders: OrderRow[] = [
      { total: 1000, status: 'faturado', order_date_kpi: '2026-06-04' },
      { total: 500, status: 'cancelado', order_date_kpi: '2026-06-04' }, // inválido
      { total: 300, status: 'enviado', order_date_kpi: '2026-06-03' }, // fora da janela "hoje"
      { total: 999, status: 'rascunho', order_date_kpi: '2026-06-04' }, // inválido
      { total: 42, status: 'faturado', order_date_kpi: null }, // sem data → fora
    ];
    expect(somarReceita(orders, '2026-06-04', '2026-06-05')).toBe(1000); // só o faturado de hoje
    expect(somarReceita(orders, '2026-06-01', '2026-06-05')).toBe(1300); // faturado + enviado (mês)
  });

  it('contarAtivos: distinct id com ts ≥ desde; ignora id/ts nulos', () => {
    const linhas: AtividadeRow[] = [
      { id: 'A', ts: '2026-06-04T12:00:00Z' },
      { id: 'A', ts: '2026-06-04T15:00:00Z' }, // mesmo A
      { id: 'B', ts: '2026-06-04T12:00:00Z' },
      { id: 'C', ts: '2026-06-01T12:00:00Z' }, // antes da janela "hoje"
      { id: null, ts: '2026-06-04T12:00:00Z' }, // sem id
      { id: 'D', ts: null }, // sem ts
    ];
    expect(contarAtivos(linhas, '2026-06-04T03:00:00.000Z')).toBe(2); // A, B
    expect(contarAtivos(linhas, '2026-05-28T03:00:00.000Z')).toBe(3); // A, B, C
  });
});
