import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Teste de contrato do getCapitalDeGiro (tela Posição Agora em /financeiro).
 * Irmão dos bugs #719/#720: as queries de CR/CP aberto não tinham .range() → o
 * PostgREST capa em 1000 linhas (a oben tem ~11k CR abertos) e TUDO que deriva
 * das linhas saía truncado: total_cr/cp_aberto, capital_giro, concentração
 * top-5 e a projeção 30d (entradas/saidas_30d).
 *
 * O mock reproduz o comportamento REAL do PostgREST: query sem .range() devolve
 * no máximo 1000 linhas; com .range(from, to) devolve a janela (capada em
 * 1000). Seeds têm valor_documento/valor_recebido/valor_pago/saldo coerentes
 * (saldo é coluna gerada), então os testes só falham por truncamento/filtro.
 */

type Row = Record<string, unknown>;

const state: {
  db: Record<string, Row[]>;
  errors: Record<string, { message: string } | undefined>;
} = { db: {}, errors: {} };

function makeBuilder(tabela: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let janela: { from: number; to: number } | null = null;
  let single = false;
  const builder = {
    select: (_cols: string) => builder,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    order: (_col: string) => builder,
    range: (from: number, to: number) => {
      janela = { from, to };
      return builder;
    },
    maybeSingle: () => {
      single = true;
      return builder;
    },
    then: (
      resolve: (v: { data: Row[] | Row | null; error: { message: string } | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const error = state.errors[tabela];
      if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
      const matched = (state.db[tabela] ?? []).filter((r) => filters.every((f) => f(r)));
      // PostgREST real: max-rows de 1000 vale SEMPRE — sem range capa em 1000, e
      // com range a janela nunca passa de 1000 linhas (um `.range(0, 99999)` NÃO
      // fura o cap; só paginação de verdade soma tudo).
      const rows = janela
        ? matched.slice(janela.from, Math.min(janela.to + 1, janela.from + 1000))
        : matched.slice(0, 1000);
      const data = single ? (rows[0] ?? null) : rows;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => makeBuilder(tabela) },
}));

import { getCapitalDeGiro } from '@/services/financeiroService';

// Vencimentos relativos (mesmo cálculo UTC do serviço): dentro e fora da janela de 30d.
const dentroDe30 = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const foraDe30 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

const cr = (company: string, saldo: number, venc: string | null, cliente = 'Cliente X'): Row => ({
  company,
  status_titulo: 'A VENCER',
  saldo,
  valor_documento: saldo,
  valor_recebido: 0,
  data_vencimento: venc,
  nome_cliente: cliente,
});

const cp = (company: string, saldo: number, venc: string | null, fornecedor = 'Fornecedor X'): Row => ({
  company,
  status_titulo: 'A VENCER',
  saldo,
  valor_documento: saldo,
  valor_pago: 0,
  data_vencimento: venc,
  nome_fornecedor: fornecedor,
});

const muitos = (n: number, make: (i: number) => Row): Row[] =>
  Array.from({ length: n }, (_, i) => make(i));

describe('getCapitalDeGiro (Posição Agora)', () => {
  beforeEach(() => {
    state.db = {
      fin_contas_receber: [],
      fin_contas_pagar: [],
      fin_contas_correntes: [],
      v_capital_giro_prazos: [],
    };
    state.errors = {};
  });

  it('soma TODOS os títulos abertos mesmo acima do cap de 1000 do PostgREST', async () => {
    state.db.fin_contas_receber = muitos(2500, () => cr('oben', 10, foraDe30));
    state.db.fin_contas_pagar = muitos(1200, () => cp('oben', 5, foraDe30));
    state.db.fin_contas_correntes = [{ company: 'oben', ativo: true, saldo_atual: 1000 }];

    const [giro] = await getCapitalDeGiro('oben');

    expect(giro.total_cr_aberto).toBe(2500 * 10);
    expect(giro.total_cp_aberto).toBe(1200 * 5);
    expect(giro.capital_giro).toBe(2500 * 10 - 1200 * 5);
    expect(giro.capital_giro_liquido).toBe(2500 * 10 + 1000 - 1200 * 5);
    expect(giro.saldo_cc).toBe(1000);
  });

  it('concentração top-5 enxerga cliente/fornecedor concentrado além da 1ª página', async () => {
    // 1000 títulos pulverizados (clientes distintos) na frente + o concentrado SÓ depois:
    // truncado, o top-5 viraria 5/1000 = 0,5% em vez de ~91%.
    state.db.fin_contas_receber = [
      ...muitos(1000, (i) => cr('oben', 1, foraDe30, `Cliente ${i}`)),
      ...muitos(200, () => cr('oben', 50, foraDe30, 'GIGANTE')),
    ];
    state.db.fin_contas_pagar = [
      ...muitos(1000, (i) => cp('oben', 1, foraDe30, `Fornecedor ${i}`)),
      ...muitos(100, () => cp('oben', 30, foraDe30, 'MEGA FORNECEDOR')),
    ];

    const [giro] = await getCapitalDeGiro('oben');

    // CR: total 11000; top5 = GIGANTE (10000) + 4 clientes de 1
    expect(giro.top5_cr_pct).toBeCloseTo((10004 / 11000) * 100, 6);
    // CP: total 4000; top5 = MEGA (3000) + 4 fornecedores de 1
    expect(giro.top5_cp_pct).toBeCloseTo((3004 / 4000) * 100, 6);
  });

  it('projeção 30d soma vencimentos na janela mesmo além da 1ª página', async () => {
    state.db.fin_contas_receber = [
      ...muitos(1000, () => cr('oben', 2, foraDe30)),
      ...muitos(300, () => cr('oben', 7, dentroDe30)),
    ];
    state.db.fin_contas_pagar = [
      ...muitos(1100, () => cp('oben', 3, foraDe30)),
      ...muitos(50, () => cp('oben', 4, dentroDe30)),
    ];
    state.db.fin_contas_correntes = [{ company: 'oben', ativo: true, saldo_atual: 500 }];

    const [giro] = await getCapitalDeGiro('oben');

    expect(giro.entradas_30d).toBe(300 * 7);
    expect(giro.saidas_30d).toBe(50 * 4);
    expect(giro.saldo_projetado_30d).toBe(500 + 300 * 7 - 50 * 4);
  });

  it('janela de 30d usa o dia de SÃO PAULO, não UTC (à noite o "hoje" UTC já é amanhã)', async () => {
    // 23:30 em SP (UTC-3) = 02:30 UTC do dia seguinte. Em UTC, today viraria
    // 2026-06-12: o vencimento de HOJE (11/06 SP) sairia da projeção e um 31º
    // dia (12/07) entraria — mesmo bug de fuso do #550 (achado codex pós-#722).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-12T02:30:00Z') });
    try {
      state.db.fin_contas_receber = [
        cr('oben', 10, '2026-06-11'), // vence HOJE em SP → conta
        cr('oben', 7, '2026-07-11'), // 30º dia em SP → conta
        cr('oben', 99, '2026-07-12'), // 31º dia em SP (= in30 do cálculo UTC) → fora
      ];

      const [giro] = await getCapitalDeGiro('oben');

      expect(giro.entradas_30d).toBe(10 + 7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abertos = OPEN_TITLE_STATUSES (VENCE HOJE conta; RECEBIDO/CANCELADO não; outra empresa fora)', async () => {
    state.db.fin_contas_receber = [
      cr('oben', 10, null),
      { ...cr('oben', 5, null), status_titulo: 'ATRASADO' },
      { ...cr('oben', 3, null), status_titulo: 'VENCE HOJE' },
      { ...cr('oben', 99, null), status_titulo: 'RECEBIDO' },
      { ...cr('oben', 99, null), status_titulo: 'CANCELADO' },
      cr('colacor', 77, null),
    ];

    const [giro] = await getCapitalDeGiro('oben');

    expect(giro.total_cr_aberto).toBe(10 + 5 + 3);
  });

  it('prazos: cobertura suficiente usa PMR/PMP da view; cobertura baixa vira null (—)', async () => {
    state.db.v_capital_giro_prazos = [
      { company: 'oben', pmr: 30, pmp: 10, pmr_cobertura: 0.98, pmp_cobertura: 0.95 },
      { company: 'colacor', pmr: 20, pmp: 77, pmr_cobertura: 0.1, pmp_cobertura: 0.1 },
    ];

    const [oben] = await getCapitalDeGiro('oben');
    expect(oben.pmr).toBe(30);
    expect(oben.pmp).toBe(10);
    expect(oben.ciclo_financeiro).toBe(20);

    const [colacor] = await getCapitalDeGiro('colacor');
    expect(colacor.pmr).toBeNull();
    expect(colacor.pmp).toBeNull();
    expect(colacor.ciclo_financeiro).toBeNull();
  });

  it('all retorna as 3 empresas', async () => {
    state.db.fin_contas_receber = [cr('oben', 1, null), cr('colacor', 2, null), cr('colacor_sc', 3, null)];

    const giros = await getCapitalDeGiro('all');

    expect(giros.map((g) => g.company)).toEqual(['oben', 'colacor', 'colacor_sc']);
    expect(giros.map((g) => g.total_cr_aberto)).toEqual([1, 2, 3]);
  });

  it('erro em CR/CP LANÇA Error real (antes virava R$0 silencioso na tela)', async () => {
    state.errors.fin_contas_receber = { message: 'RLS negou' };
    await expect(getCapitalDeGiro('oben')).rejects.toBeInstanceOf(Error);

    state.errors = { fin_contas_pagar: { message: 'timeout' } };
    await expect(getCapitalDeGiro('oben')).rejects.toBeInstanceOf(Error);
  });

  it('erro nas contas correntes também LANÇA — caixa R$0 falso engana igual', async () => {
    state.db.fin_contas_receber = [cr('oben', 10, null)];
    state.errors.fin_contas_correntes = { message: 'tabela indisponível' };
    await expect(getCapitalDeGiro('oben')).rejects.toBeInstanceOf(Error);
  });

  it('erro na view de prazos NÃO derruba a tela — pmr/pmp ficam null (dado acessório)', async () => {
    state.db.fin_contas_receber = [cr('oben', 10, null)];
    state.errors.v_capital_giro_prazos = { message: 'view indisponível' };

    const [giro] = await getCapitalDeGiro('oben');

    expect(giro.total_cr_aberto).toBe(10);
    expect(giro.pmr).toBeNull();
    expect(giro.pmp).toBeNull();
  });
});
