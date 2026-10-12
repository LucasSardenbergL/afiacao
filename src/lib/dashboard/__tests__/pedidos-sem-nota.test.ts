import { describe, it, expect } from 'vitest';
import { STATUS_SEM_NOTA, janelaSemNotaAntiga, resumirSemNota } from '../pedidos-sem-nota';
import { STATUS_NAO_VENDA } from '@/lib/farmer/universo-pedidos';

describe('STATUS_SEM_NOTA', () => {
  it('são os status do Omie anteriores à nota — nem faturado, nem cancelado, nem status do app', () => {
    expect([...STATUS_SEM_NOTA].sort()).toEqual(['enviado', 'importado', 'separacao']);
  });

  it('todos estão DENTRO do universo de venda (é por isso que contam como venda)', () => {
    for (const s of STATUS_SEM_NOTA) expect(STATUS_NAO_VENDA).not.toContain(s);
  });
});

describe('janelaSemNotaAntiga', () => {
  it('último ano, excluindo os 30 dias mais recentes (pedido recente sem nota é fila normal)', () => {
    expect(janelaSemNotaAntiga('2026-10-12')).toEqual({ de: '2025-10-12', ate: '2026-09-12' });
  });

  it('atravessa fevereiro e a virada do ano sem erro de calendário', () => {
    expect(janelaSemNotaAntiga('2026-03-01')).toEqual({ de: '2025-03-01', ate: '2026-01-30' });
  });
});

describe('resumirSemNota', () => {
  it('soma receita e conta pedidos, total e por empresa (maior primeiro)', () => {
    const r = resumirSemNota([
      { account: 'colacor', total: 100 },
      { account: 'oben', total: 300 },
      { account: 'oben', total: 200 },
    ]);
    expect(r.receita).toBe(600);
    expect(r.pedidos).toBe(3);
    expect(r.porEmpresa).toEqual([
      { account: 'oben', receita: 500, pedidos: 2 },
      { account: 'colacor', receita: 100, pedidos: 1 },
    ]);
  });

  it('pedido sem valor conta como pedido e soma R$ 0 (não some da contagem)', () => {
    const r = resumirSemNota([{ account: 'oben', total: null }]);
    expect(r).toEqual({ receita: 0, pedidos: 1, porEmpresa: [{ account: 'oben', receita: 0, pedidos: 1 }] });
  });

  it('lista vazia = zero MEDIDO (não ausência)', () => {
    expect(resumirSemNota([])).toEqual({ receita: 0, pedidos: 0, porEmpresa: [] });
  });
});
