import { describe, it, expect } from 'vitest';
import { montarKpisVisita } from '../kpis';

describe('montarKpisVisita', () => {
  it('deriva conversão, sem-resultado, ticket médio só de fechados COM valor', () => {
    const k = montarKpisVisita([
      { result: 'pedido_fechado', revenue_generated: 1000 },
      { result: 'pedido_fechado', revenue_generated: null }, // fechado SEM valor → fora do ticket
      { result: 'interesse', revenue_generated: null },
      { result: 'ausente', revenue_generated: null },
      { result: null, revenue_generated: null }, // sem resultado registrado
    ]);
    expect(k.totalVisitas).toBe(5);
    expect(k.comResultado).toBe(4);
    expect(k.semResultado).toBe(1);
    expect(k.fechados).toBe(2);
    expect(k.taxaConversao).toBe(0.5); // 2 ÷ 4
    expect(k.fechadosComValor).toBe(1);
    expect(k.fechadosSemValor).toBe(1);
    expect(k.receitaTotal).toBe(1000); // só dos fechados com valor
    expect(k.ticketMedio).toBe(1000); // 1000 ÷ 1
  });

  it('sem fechados (só mornos) → conversão 0 (não null), ticket null', () => {
    const k = montarKpisVisita([
      { result: 'interesse', revenue_generated: null },
      { result: 'ausente', revenue_generated: null },
    ]);
    expect(k.taxaConversao).toBe(0);
    expect(k.fechados).toBe(0);
    expect(k.ticketMedio).toBeNull();
  });

  it('lista vazia → zeros e null nas razões', () => {
    const k = montarKpisVisita([]);
    expect(k).toMatchObject({
      totalVisitas: 0, comResultado: 0, semResultado: 0, fechados: 0,
      taxaConversao: null, fechadosComValor: 0, receitaTotal: 0, ticketMedio: null,
    });
  });
});
