import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chaveMes,
  formatarMesAno,
  chaveMesAtual,
  gerarRangeMeses,
  agruparPorMes,
  chavesUltimosNMeses,
} from '../agruparPorMes';

// Fixa "hoje" em 15/05/2026 (local) para as funções que usam new Date().
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('chaveMes', () => {
  it('extrai YYYY-MM de data ISO (curta ou completa)', () => {
    expect(chaveMes('2026-04-15')).toBe('2026-04');
    expect(chaveMes('2026-04-15T10:30:00Z')).toBe('2026-04');
  });

  it('null/undefined/vazio/sem mês → null', () => {
    expect(chaveMes(null)).toBeNull();
    expect(chaveMes(undefined)).toBeNull();
    expect(chaveMes('')).toBeNull();
    expect(chaveMes('2026')).toBeNull();
    expect(chaveMes('lixo')).toBeNull();
  });
});

describe('formatarMesAno', () => {
  it('YYYY-MM → "Mês Ano" em pt-BR', () => {
    expect(formatarMesAno('2026-01')).toBe('Janeiro 2026');
    expect(formatarMesAno('2026-04')).toBe('Abril 2026');
    expect(formatarMesAno('2026-12')).toBe('Dezembro 2026');
  });

  it('mês fora de 1-12 ou inválido → devolve a chave crua', () => {
    expect(formatarMesAno('2026-13')).toBe('2026-13');
    expect(formatarMesAno('2026-00')).toBe('2026-00');
    expect(formatarMesAno('abc')).toBe('abc');
  });
});

describe('chaveMesAtual', () => {
  it('retorna o mês corrente (com new Date fixado)', () => {
    expect(chaveMesAtual()).toBe('2026-05');
  });
});

describe('gerarRangeMeses', () => {
  it('mesmo mês → uma chave', () => {
    expect(gerarRangeMeses('2026-04', '2026-04')).toEqual(['2026-04']);
  });

  it('intervalo no mesmo ano, ordenado do mais recente p/ o mais antigo', () => {
    expect(gerarRangeMeses('2026-01', '2026-03')).toEqual(['2026-03', '2026-02', '2026-01']);
  });

  it('atravessa a virada de ano', () => {
    expect(gerarRangeMeses('2025-11', '2026-02')).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });

  it('recente anterior ao antigo → vazio', () => {
    expect(gerarRangeMeses('2026-05', '2026-03')).toEqual([]);
  });

  it('chave inválida → vazio', () => {
    expect(gerarRangeMeses('', '')).toEqual([]);
    expect(gerarRangeMeses('2026-04', 'xx')).toEqual([]);
  });
});

describe('chavesUltimosNMeses', () => {
  it('retorna o conjunto dos N meses mais recentes (com new Date fixado)', () => {
    expect(chavesUltimosNMeses(3)).toEqual(new Set(['2026-05', '2026-04', '2026-03']));
  });

  it('atravessa a virada de ano para trás', () => {
    expect(chavesUltimosNMeses(6)).toEqual(
      new Set(['2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12']),
    );
  });
});

describe('agruparPorMes', () => {
  type Reg = { quando: string | null };
  const pegar = (r: Reg) => r.quando;

  it('lista vazia → []', () => {
    expect(agruparPorMes([], pegar)).toEqual([]);
  });

  it('agrupa por mês e preenche meses vazios entre o mais antigo e o mês atual', () => {
    const itens: Reg[] = [{ quando: '2026-03-10' }, { quando: '2026-05-02' }, { quando: '2026-05-20' }];
    const grupos = agruparPorMes(itens, pegar);
    expect(grupos.map((g) => g.chave)).toEqual(['2026-05', '2026-04', '2026-03']);
    expect(grupos[0]).toMatchObject({ chave: '2026-05', label: 'Maio 2026', vazio: false });
    expect(grupos[0].itens).toHaveLength(2);
    expect(grupos[1]).toMatchObject({ chave: '2026-04', vazio: true });
    expect(grupos[1].itens).toEqual([]);
    expect(grupos[2]).toMatchObject({ chave: '2026-03', vazio: false });
  });

  it('estende o range até um item futuro, preenchendo os meses vazios (inclui o mês atual)', () => {
    // item mais antigo 2026-03, item futuro 2026-07, "hoje" 2026-05
    const grupos = agruparPorMes([{ quando: '2026-03-01' }, { quando: '2026-07-01' }], pegar);
    expect(grupos.map((g) => g.chave)).toEqual(['2026-07', '2026-06', '2026-05', '2026-04', '2026-03']);
    expect(grupos[0]).toMatchObject({ chave: '2026-07', vazio: false });
    expect(grupos.find((g) => g.chave === '2026-05')).toMatchObject({ vazio: true }); // mês atual, sem item
  });

  it('um único item futuro NÃO faz padding até o mês atual (range = só o item)', () => {
    const grupos = agruparPorMes([{ quando: '2026-07-01' }], pegar);
    expect(grupos.map((g) => g.chave)).toEqual(['2026-07']);
  });

  it('ignora itens sem data válida', () => {
    const grupos = agruparPorMes([{ quando: null }, { quando: 'lixo' }], pegar);
    expect(grupos).toEqual([]);
  });
});
