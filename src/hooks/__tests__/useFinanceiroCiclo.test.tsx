// Hooks da aba Ciclo com o mock no nível do CLIENT supabase (não do módulo do hook):
// normalização snake_case→camelCase, descartes (ausente ≠ zero), janela TTM e erro exposto.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Resp = { data: Record<string, unknown>[] | null; error: unknown };
const tabelas: Record<string, Resp> = {};
const consultas: Array<{ tabela: string; de?: number }> = [];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      const encadeia = () => b;
      for (const m of ['select', 'eq', 'gte', 'order']) b[m] = encadeia;
      // fetchAllPages: 1ª página = linhas da tabela; 2ª (de > 0) = [] (fim)
      b.range = (de: number) => {
        consultas.push({ tabela, de });
        return Promise.resolve(de === 0 ? tabelas[tabela] : { data: [], error: null });
      };
      // leitura sem paginação (coorte): o builder é thenable
      b.then = (ok: (r: Resp) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(tabelas[tabela]).then(ok, ko);
      return b;
    },
  },
}));

import { useCicloCoorte, useCicloResumo, useReceitaDiariaTtm } from '../useFinanceiroCiclo';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, children);

const dre = (company: string, ano: number, mes: number, valor: string | null, cat = '1.01') =>
  ({ company, ano, mes, categoria_codigo: cat, valor_total: valor });

beforeEach(() => {
  for (const k of Object.keys(tabelas)) delete tabelas[k];
  consultas.length = 0;
  // 01:30 UTC de 01/11 = 31/10 22:30 em São Paulo → o mês corrente de hojeSp é OUTUBRO/2026 (não novembro)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T01:30:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('useCicloResumo', () => {
  it('normaliza snake_case com numeric string→number, null preservado, e descarta linha sem omie_codigo_cliente', async () => {
    tabelas.v_ciclo_cliente_resumo = {
      error: null,
      data: [
        { company: 'oben', omie_codigo_cliente: 7, nome_cliente: 'ACME', valor_pago: '1234.50', saldo_vencido: null, n_documentos: '8', prazo_real_pond: '31.25' },
        { company: 'oben', omie_codigo_cliente: null, nome_cliente: 'SEM CHAVE', valor_pago: '10' },
      ],
    };
    const { result } = renderHook(() => useCicloResumo(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    const c = result.current.data![0];
    expect(c).toMatchObject({ company: 'oben', omieCodigoCliente: 7, nomeCliente: 'ACME', valorPago: 1234.5, nDocumentos: 8, prazoRealPond: 31.25 });
    expect(c.saldoVencido).toBeNull(); // ausente ≠ zero
    expect(c.atrasoP80).toBeNull();
    expect(consultas.some((q) => q.tabela === 'v_ciclo_cliente_resumo' && q.de === 0)).toBe(true); // paginou pela 1ª página
  });

  it('erro do supabase vira `error` do hook (não lista vazia)', async () => {
    tabelas.v_ciclo_cliente_resumo = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useCicloResumo(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeUndefined();
  });
});

describe('useCicloCoorte', () => {
  it('normaliza e descarta linha com valor_vencido_no_mes null', async () => {
    tabelas.v_ciclo_empresa_coorte = {
      error: null,
      data: [
        { company: 'oben', mes_vencimento: '2026-08-01', valor_vencido_no_mes: '1000.00', valor_pago: '900.5', valor_em_aberto: '99.5', pct_valor_pago: '0.9', prazo_concedido_pond: '30', prazo_real_pond_pagas: null, atraso_pond_pagas: null, mes_parcial: false },
        { company: 'oben', mes_vencimento: '2026-09-01', valor_vencido_no_mes: null, valor_pago: '1', valor_em_aberto: '1', mes_parcial: true },
      ],
    };
    const { result } = renderHook(() => useCicloCoorte(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{
      company: 'oben', mes: '2026-08-01', valorVencido: 1000, valorPago: 900.5, valorEmAberto: 99.5,
      pctValorPago: 0.9, prazoConcedido: 30, prazoReal: null, atraso: null, mesParcial: false,
    }]);
  });

  it('erro do supabase vira `error` do hook', async () => {
    tabelas.v_ciclo_empresa_coorte = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useCicloCoorte(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useReceitaDiariaTtm', () => {
  it('TTM = Σ(12 meses cheios antes do corrente)/365: inclui o mesmo mês do ano anterior, exclui o corrente; conta meses distintos', async () => {
    tabelas.fin_dre_competencia_base = {
      error: null,
      data: [
        dre('oben', 2025, 9, '99999.00'), // fora (antes da janela)
        dre('oben', 2025, 10, '3650.00'), // dentro (borda inferior: mesmo mês do ano anterior)
        dre('oben', 2025, 10, '3650.00', '1.02'), // mesmo mês, outra categoria → soma, mas é 1 mês só
        dre('oben', 2026, 9, '3650.00'), // dentro (último mês cheio)
        dre('oben', 2026, 10, '88888.00'), // mês corrente → EXCLUÍDO
        dre('oben', 2026, 5, null), // valor ausente: não soma e não conta como mês com dado
        dre('colacor', 2026, 3, '730.00'),
        dre('colacor_sc', 2026, 10, '500.00'), // só mês corrente → fora → sem dado
      ],
    };
    const { result } = renderHook(() => useReceitaDiariaTtm(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;
    expect(d.oben.porDia).toBeCloseTo((3650 + 3650 + 3650) / 365, 10); // = 30
    expect(d.oben.mesesComDado).toBe(2); // 2025-10 e 2026-09
    expect(d.colacor).toEqual({ porDia: 2, mesesComDado: 1 });
    expect(d.colacor_sc).toEqual({ porDia: null, mesesComDado: 0 }); // sem linha na janela → null, nunca 0
  });

  it('empresa sem nenhuma linha → null / 0 meses', async () => {
    tabelas.fin_dre_competencia_base = { error: null, data: [dre('oben', 2026, 1, '365.00')] };
    const { result } = renderHook(() => useReceitaDiariaTtm(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.colacor).toEqual({ porDia: null, mesesComDado: 0 });
    expect(result.current.data!.oben).toEqual({ porDia: 1, mesesComDado: 1 });
  });

  it('erro do supabase vira `error` do hook', async () => {
    tabelas.fin_dre_competencia_base = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useReceitaDiariaTtm(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
