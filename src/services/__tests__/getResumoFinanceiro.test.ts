import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Teste de contrato do getResumoFinanceiro (resumo do FinanceiroDashboard /
 * Cockpit). Irmão do bug do KPI de /financeiro/gestao (#719): as somas de CR/CP
 * aberto+vencido eram reduce client-side SEM paginação → o PostgREST capa em
 * 1000 linhas e `total_a_receber`/`total_vencido_*` saíam truncados (oben tem
 * ~11k títulos de CR aberto).
 *
 * O mock abaixo reproduz o comportamento REAL do PostgREST: query sem .range()
 * devolve no máximo 1000 linhas; com .range(from, to) devolve a janela. Os
 * títulos do seed têm valor_documento/valor_recebido/valor_pago/saldo coerentes
 * (saldo é coluna gerada = documento − recebido/pago), então estes testes só
 * falham por truncamento/filtro errado — não por forma de coluna.
 */

type Row = Record<string, unknown>;

const state: {
  db: Record<string, Row[]>;
  errors: Record<string, { message: string } | undefined>;
} = { db: {}, errors: {} };

function makeBuilder(tabela: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let janela: { from: number; to: number } | null = null;
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
    then: (
      resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const error = state.errors[tabela];
      if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
      const matched = (state.db[tabela] ?? []).filter((r) => filters.every((f) => f(r)));
      // PostgREST real: max-rows de 1000 vale SEMPRE — sem range capa em 1000, e
      // com range a janela devolvida nunca passa de 1000 linhas (um `.range(0,
      // 99999)` NÃO fura o cap; só paginação de verdade soma tudo).
      const rows = janela
        ? matched.slice(janela.from, Math.min(janela.to + 1, janela.from + 1000))
        : matched.slice(0, 1000);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => makeBuilder(tabela) },
}));

import { getResumoFinanceiro } from '@/services/financeiroService';

const titulo = (company: string, status: string, saldo: number): Row => ({
  company,
  status_titulo: status,
  saldo,
  valor_documento: saldo,
  valor_recebido: 0,
  valor_pago: 0,
});

const muitos = (n: number, company: string, status: string, saldo: number): Row[] =>
  Array.from({ length: n }, () => titulo(company, status, saldo));

describe('getResumoFinanceiro (contrato do resumo do dashboard)', () => {
  beforeEach(() => {
    state.db = { fin_contas_correntes: [], fin_contas_receber: [], fin_contas_pagar: [] };
    state.errors = {};
  });

  it('soma TODOS os títulos abertos mesmo acima do cap de 1000 do PostgREST (CR e CP)', async () => {
    state.db.fin_contas_receber = muitos(1500, 'oben', 'A VENCER', 10);
    state.db.fin_contas_pagar = muitos(1200, 'oben', 'A VENCER', 5);

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.total_a_receber).toBe(1500 * 10);
    expect(resumo.oben.total_a_pagar).toBe(1200 * 5);
    expect(resumo.oben.posicao_liquida).toBe(1500 * 10 - 1200 * 5);
  });

  it('soma TODOS os vencidos (ATRASADO) mesmo acima do cap de 1000', async () => {
    state.db.fin_contas_receber = [
      ...muitos(1100, 'oben', 'ATRASADO', 2),
      ...muitos(50, 'oben', 'A VENCER', 3),
    ];
    state.db.fin_contas_pagar = muitos(1050, 'oben', 'ATRASADO', 4);

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.total_vencido_receber).toBe(1100 * 2);
    expect(resumo.oben.total_vencido_pagar).toBe(1050 * 4);
    // ATRASADO também é aberto → compõe o total a receber junto com A VENCER
    expect(resumo.oben.total_a_receber).toBe(1100 * 2 + 50 * 3);
  });

  it('ignora liquidados/cancelados (saldo bogus do #396) e títulos de outra empresa', async () => {
    state.db.fin_contas_receber = [
      titulo('oben', 'A VENCER', 10),
      titulo('oben', 'VENCE HOJE', 7),
      titulo('oben', 'RECEBIDO', 99), // liquidado: saldo cheio por causa do #396 — fora
      titulo('oben', 'CANCELADO', 50),
      titulo('colacor', 'A VENCER', 77), // outra empresa — fora
    ];
    state.db.fin_contas_pagar = [
      titulo('oben', 'ATRASADO', 6),
      titulo('oben', 'PAGO', 88),
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.total_a_receber).toBe(10 + 7);
    expect(resumo.oben.total_a_pagar).toBe(6);
    expect(resumo.oben.total_vencido_receber).toBe(0);
    expect(resumo.oben.total_vencido_pagar).toBe(6);
  });

  it('contas correntes: soma só as ativas da empresa e normaliza campos null', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 100, banco: '341' },
      { company: 'oben', ativo: true, descricao: null, saldo_atual: null, banco: null },
      { company: 'oben', ativo: false, descricao: 'Encerrada', saldo_atual: 999, banco: '237' },
      { company: 'colacor', ativo: true, descricao: 'Outra', saldo_atual: 55, banco: '001' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.saldo_total_cc).toBe(100);
    expect(resumo.oben.contas_correntes).toEqual([
      { descricao: 'Itaú', saldo_atual: 100, banco: '341' },
      { descricao: '', saldo_atual: 0, banco: '' },
    ]);
  });

  it('erro nos títulos LANÇA um Error real (nunca resumo parcial silencioso, nem "[object Object]" no banner)', async () => {
    state.db.fin_contas_receber = muitos(10, 'oben', 'A VENCER', 1);
    state.errors.fin_contas_pagar = { message: 'RLS negou' };
    await expect(getResumoFinanceiro(['oben'])).rejects.toBeInstanceOf(Error);
  });

  it('erro nas contas correntes também LANÇA — caixa R$0 falso é tão ruim quanto total truncado', async () => {
    state.errors.fin_contas_correntes = { message: 'tabela indisponível' };
    await expect(getResumoFinanceiro(['oben'])).rejects.toBeInstanceOf(Error);
  });
});
