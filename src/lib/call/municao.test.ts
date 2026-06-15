import { describe, it, expect } from 'vitest';
import { derivarMunicao } from './municao';

const hoje = new Date('2026-06-13T12:00:00Z');

describe('derivarMunicao', () => {
  it('dias desde a última + última + ticket', () => {
    const r = derivarMunicao({ pedidos: [{ data: '2026-06-01', valor: 1200 }, { data: '2026-05-01', valor: 800 }], agora: hoje });
    expect(r.diasDesdeUltima).toBe(12);
    expect(r.ultimaCompra).toEqual({ data: '2026-06-01', valor: 1200 });
    expect(r.ticketMedio).toBe(1000);
  });

  it('sem histórico → null honesto', () => {
    expect(derivarMunicao({ pedidos: [], agora: hoje })).toEqual({ diasDesdeUltima: null, ultimaCompra: null, ticketMedio: null });
  });

  it('ignora datas futuras (order_date_kpi pode vir adiantado)', () => {
    const r = derivarMunicao({ pedidos: [{ data: '2026-07-01', valor: 999 }, { data: '2026-06-10', valor: 500 }], agora: hoje });
    expect(r.ultimaCompra?.data).toBe('2026-06-10');
    expect(r.diasDesdeUltima).toBe(3);
  });
});
