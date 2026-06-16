import { describe, it, expect } from 'vitest';
import { agregarRealizadoPorDia, type MovimentoRealizado } from '../fluxo-realizado-helpers';

function mk(o: Partial<MovimentoRealizado>): MovimentoRealizado {
  return { data_movimento: '2026-01-10', tipo: 'E', valor: 100, omie_codigo_lancamento: 1, ...o };
}

describe('agregarRealizadoPorDia', () => {
  it('lista vazia → map vazio', () => {
    expect(agregarRealizadoPorDia([]).size).toBe(0);
  });

  it('soma E em entradas e S em saídas, por dia', () => {
    const m = agregarRealizadoPorDia([
      mk({ data_movimento: '2026-01-10', tipo: 'E', valor: 100 }),
      mk({ data_movimento: '2026-01-10', tipo: 'E', valor: 50 }),
      mk({ data_movimento: '2026-01-10', tipo: 'S', valor: 30 }),
      mk({ data_movimento: '2026-01-11', tipo: 'S', valor: 20 }),
    ]);
    expect(m.get('2026-01-10')).toEqual({ entradas: 150, saidas: 30 });
    expect(m.get('2026-01-11')).toEqual({ entradas: 0, saidas: 20 });
  });

  it('exclui movimentos sem título (transferência/tarifa interna)', () => {
    const m = agregarRealizadoPorDia([
      mk({ tipo: 'E', valor: 100, omie_codigo_lancamento: null }),
      mk({ tipo: 'E', valor: 40, omie_codigo_lancamento: 7 }),
    ]);
    expect(m.get('2026-01-10')).toEqual({ entradas: 40, saidas: 0 });
  });

  it('usa valor absoluto (defensivo)', () => {
    const m = agregarRealizadoPorDia([mk({ tipo: 'S', valor: -25 })]);
    expect(m.get('2026-01-10')).toEqual({ entradas: 0, saidas: 25 });
  });

  it('ignora data_movimento vazia', () => {
    const m = agregarRealizadoPorDia([mk({ data_movimento: '' as string })]);
    expect(m.size).toBe(0);
  });
});
