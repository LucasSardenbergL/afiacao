import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contrato do drill de variância por categoria (`getCategoriasCompetenciaRaw`): pagina a
 * `fin_dre_competencia_base` inteira pelo paginador canônico (`fetchAllPages`). Trava:
 *  1. ordem TOTAL no recorte (código, descrição, mês, origem) — sem ela o offset pula/duplica;
 *  2. pagina além do cap de 1000 e mapeia `valor_total ?? 0`;
 *  3. página perdida (error OU data null sem error) LANÇA — nunca drill parcial — e é MEDIDA
 *     (captureException com a fonte), que o laço manual anterior não fazia.
 */

type Row = { categoria_codigo: string; categoria_descricao: string; mes: number; valor_total: number | null };

const state: {
  pages: Array<{ data: Row[] | null; error: { message: string } | null }>;
  ranges: Array<[number, number]>;
  orders: string[];
} = { pages: [], ranges: [], orders: [] };

function builder() {
  const b = {
    select: () => b,
    eq: () => b,
    in: () => b,
    order: (col: string) => {
      state.orders.push(col);
      return b;
    },
    range: (de: number, ate: number) => {
      state.ranges.push([de, ate]);
      return Promise.resolve(state.pages[Math.floor(de / 1000)] ?? { data: [], error: null });
    },
  };
  return b;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));

const captureExceptionMock = vi.fn();
vi.mock('@/lib/analytics', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...a),
}));

import { getCategoriasCompetenciaRaw } from '@/services/financeiroV2Service';

const page = (n: number, valor: number | null = 10): { data: Row[]; error: null } => ({
  data: Array.from({ length: n }, (_, i) => ({
    categoria_codigo: `2.01.${i}`,
    categoria_descricao: 'X',
    mes: 1,
    valor_total: valor,
  })),
  error: null,
});

describe('getCategoriasCompetenciaRaw', () => {
  beforeEach(() => {
    state.pages = [];
    state.ranges = [];
    state.orders = [];
    captureExceptionMock.mockClear();
  });

  it('pagina além do cap de 1000 com ordem total e mapeia valor_total ?? 0', async () => {
    state.pages = [page(1000, 2), page(3, null)];
    const rows = await getCategoriasCompetenciaRaw('colacor', 2026, [1, 2]);
    expect(rows).toHaveLength(1003);
    expect(rows[0].valor).toBe(2);
    expect(rows[1002].valor).toBe(0);
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(state.orders.slice(0, 4)).toEqual(['categoria_codigo', 'categoria_descricao', 'mes', 'origem']);
  });

  it('sem meses não consulta nada', async () => {
    expect(await getCategoriasCompetenciaRaw('colacor', 2026, [])).toEqual([]);
    expect(state.ranges).toEqual([]);
  });

  it('página com error LANÇA e é medida com a fonte', async () => {
    state.pages = [page(1000), { data: null, error: { message: 'timeout' } }];
    await expect(getCategoriasCompetenciaRaw('colacor', 2026, [1])).rejects.toBeInstanceOf(Error);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({
      fonte: 'fin_dre_competencia_base/drill-orcamento',
      pagina: 1,
      linhas_lidas_antes_da_falha: 1000,
    });
  });

  it('data null sem error LANÇA (malformada ≠ fim) e é medida', async () => {
    state.pages = [{ data: null, error: null }];
    await expect(getCategoriasCompetenciaRaw('colacor', 2026, [1])).rejects.toThrow(/data null sem error/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
