import { describe, it, expect } from 'vitest';
import { visitResultLabel, resumoVisitas } from '../visit-result';

describe('visitResultLabel', () => {
  it('mapeia cada código da taxonomia', () => {
    expect(visitResultLabel('pedido_fechado')).toEqual({ label: 'Pedido fechado', emoji: '✅', tone: 'success' });
    expect(visitResultLabel('interesse').tone).toBe('info');
    expect(visitResultLabel('sem_interesse').tone).toBe('error');
    expect(visitResultLabel('ausente').tone).toBe('warning');
    expect(visitResultLabel('reagendar').emoji).toBe('📅');
  });
  it('null/desconhecido → "Sem resultado"/muted', () => {
    expect(visitResultLabel(null)).toEqual({ label: 'Sem resultado', emoji: '—', tone: 'muted' });
    expect(visitResultLabel('xyz').tone).toBe('muted');
  });
});

describe('resumoVisitas', () => {
  it('total, comResultado, fechados, taxa (fechados/comResultado), receita', () => {
    const r = resumoVisitas([
      { result: 'pedido_fechado', revenue_generated: 1000 },
      { result: 'pedido_fechado', revenue_generated: 500 },
      { result: 'sem_interesse', revenue_generated: null },
      { result: null, revenue_generated: null },
    ]);
    expect(r).toEqual({ total: 4, comResultado: 3, fechados: 2, taxaConversao: 2 / 3, receitaTotal: 1500 });
  });
  it('sem visitas com resultado → taxa null', () => {
    expect(resumoVisitas([{ result: null, revenue_generated: null }]).taxaConversao).toBeNull();
  });
  it('lista vazia → zeros e taxa null', () => {
    expect(resumoVisitas([])).toEqual({ total: 0, comResultado: 0, fechados: 0, taxaConversao: null, receitaTotal: 0 });
  });
});
