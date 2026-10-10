import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contrato da classe "single-shot que espera a tabela INTEIRA" no financeiroService
 * (money-path §10). Três sítios, três formas da classe:
 *   - getContasPagar/Receber: single-shot sem `.range()` → oben tem ~11k títulos de CP e a
 *     lista + o export CSV nasciam com os 1.000 primeiros por vencimento;
 *   - getCategoriasOmie/getCategoryMappings: a lista-destino do mapeamento DRE, truncada;
 *   - getAgingReceber/Pagar: `if (error || !data) return EMPTY_AGING` — a falha FABRICAVA
 *     aging zerado ("R$0 vencido" indistinguível de carteira sã).
 *
 * O mock reproduz o PostgREST real: a capa de 1.000 vale SEMPRE (sem range e com range), e
 * `count: 'exact'` devolve o total do FILTRO, não da janela.
 */

type Row = Record<string, unknown>;
const CAPA = 1000;

const state: { db: Record<string, Row[]>; errors: Record<string, { message: string } | undefined> } = {
  db: {},
  errors: {},
};

function makeBuilder(tabela: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let janela: { from: number; to: number } | null = null;
  let limite: number | null = null;
  let contar = false;
  const builder = {
    select: (_cols: string, opts?: { count?: string }) => {
      contar = opts?.count === 'exact';
      return builder;
    },
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return builder; },
    in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
    gte: (col: string, val: string) => { filters.push((r) => String(r[col]) >= val); return builder; },
    lte: (col: string, val: string) => { filters.push((r) => String(r[col]) <= val); return builder; },
    order: () => builder,
    limit: (n: number) => { limite = n; return builder; },
    range: (from: number, to: number) => { janela = { from, to }; return builder; },
    then: (
      resolve: (v: { data: Row[] | null; error: { message: string } | null; count: number | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const error = state.errors[tabela];
      if (error) return Promise.resolve({ data: null, error, count: null }).then(resolve, reject);
      const matched = (state.db[tabela] ?? []).filter((r) => filters.every((f) => f(r)));
      let rows = janela ? matched.slice(janela.from, janela.to + 1) : matched;
      if (limite != null) rows = rows.slice(0, limite);
      rows = rows.slice(0, CAPA);
      return Promise.resolve({ data: rows, error: null, count: contar ? matched.length : null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => makeBuilder(t) },
}));

import {
  getContasPagar, getContasReceber, getAgingReceber, getAgingPagar, getCategoriasOmie, getCategoryMappings,
} from '../financeiroService';

function titulos(n: number, extra: Partial<Row> = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${String(i).padStart(6, '0')}`,
    company: 'oben',
    status_titulo: 'ABERTO',
    data_vencimento: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
    valor_documento: 1,
    ...extra,
  }));
}

beforeEach(() => {
  state.db = {};
  state.errors = {};
});

describe('getContasPagar/Receber — o filtro INTEIRO, não os 1.000 primeiros', () => {
  it('sem limit: pagina além da capa (2.500 títulos → 2.500, não 1.000)', async () => {
    state.db.fin_contas_pagar = titulos(2500);
    const { rows, total } = await getContasPagar('oben', { status: 'ABERTO' });
    expect(rows).toHaveLength(2500);
    expect(total).toBe(2500);
  });

  it('com limit: janela + total EXATO do filtro no mesmo request (o caller detecta o corte)', async () => {
    state.db.fin_contas_receber = titulos(2500);
    const { rows, total } = await getContasReceber('oben', { limit: 500 });
    expect(rows).toHaveLength(500);
    expect(total).toBe(2500);
  });

  it('ID repetido entre páginas (deriva de offset) LANÇA — CSV não sai com título pulado', async () => {
    // Retrato do que a deriva produz: K páginas são K instantes, um título reaparece e outro some.
    const rows = titulos(1500);
    rows[1200] = { ...rows[1200], id: rows[10].id };
    state.db.fin_contas_pagar = rows;
    await expect(getContasPagar('oben')).rejects.toThrow(/mudaram durante a leitura/);
  });

  it('falha de leitura LANÇA — nunca lista vazia com cara de "sem títulos"', async () => {
    state.errors.fin_contas_pagar = { message: 'canceling statement due to statement timeout' };
    await expect(getContasPagar('oben')).rejects.toThrow(/contas a pagar/);
  });
});

describe('getAgingReceber/Pagar — falha não fabrica aging zerado', () => {
  it('erro de leitura LANÇA (antes: EMPTY_AGING = "R$0 vencido")', async () => {
    state.errors.fin_aging_receber = { message: 'permission denied' };
    state.errors.fin_aging_pagar = { message: 'permission denied' };
    await expect(getAgingReceber('all')).rejects.toThrow(/aging de receb/);
    await expect(getAgingPagar('oben')).rejects.toThrow(/aging de pag/);
  });

  it('view VAZIA sem erro segue sendo zero LEGÍTIMO (sem títulos = aging zero de verdade)', async () => {
    state.db.fin_aging_receber = [];
    await expect(getAgingReceber('all')).resolves.toBeTruthy();
  });
});

describe('categorias do mapeamento DRE — destino inteiro', () => {
  it('getCategoriasOmie pagina além da capa', async () => {
    state.db.fin_categorias = Array.from({ length: 1500 }, (_, i) => ({
      omie_codigo: `c${i}`, descricao: `cat ${i}`, tipo: 'D', company: 'oben', ativo: true,
    }));
    expect(await getCategoriasOmie('oben')).toHaveLength(1500);
  });

  it('getCategoryMappings pagina além da capa', async () => {
    state.db.fin_categoria_dre_mapping = Array.from({ length: 1200 }, (_, i) => ({
      id: `m${i}`, company: 'oben', omie_codigo: `c${i}`, dre_linha: 'receita_bruta',
    }));
    expect(await getCategoryMappings('oben')).toHaveLength(1200);
  });
});
