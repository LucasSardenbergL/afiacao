import { describe, it, expect } from 'vitest';
import { agruparVisitasPorResultado } from '../conversao';

describe('agruparVisitasPorResultado', () => {
  it('agrupa por resultado, soma receita, calcula pct e ordena (fechado primeiro)', () => {
    const r = agruparVisitasPorResultado([
      { result: 'pedido_fechado', revenue_generated: 1000 },
      { result: 'pedido_fechado', revenue_generated: 500 },
      { result: 'interesse', revenue_generated: null },
      { result: 'ausente', revenue_generated: null },
    ]);
    expect(r.total).toBe(4);
    expect(r.receitaTotal).toBe(1500);
    expect(r.buckets.map((b) => b.result)).toEqual(['pedido_fechado', 'interesse', 'ausente']);
    const fechado = r.buckets[0];
    expect(fechado).toEqual({ result: 'pedido_fechado', count: 2, revenue: 1500, pct: 0.5 });
  });

  it('result null → bucket sem_resultado, por último', () => {
    const r = agruparVisitasPorResultado([
      { result: null, revenue_generated: null },
      { result: 'interesse', revenue_generated: null },
    ]);
    expect(r.buckets.map((b) => b.result)).toEqual(['interesse', 'sem_resultado']);
  });

  it('lista vazia → total 0, receita 0, buckets vazio', () => {
    expect(agruparVisitasPorResultado([])).toEqual({ total: 0, receitaTotal: 0, buckets: [] });
  });
});
