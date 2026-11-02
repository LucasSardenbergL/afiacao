import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Contrato do hook do cockpit em react-query (plano v4, lote 13 — C6, entrega 2):
//  - resumo que falha fica INDISPONÍVEL (null) — antes o `{}` virava CR/CP = 0 e "0,0%" verde;
//  - cada bloco cai sozinho, com o mesmo fallback de antes;
//  - trocar o regime refaz SÓ a DRE; remontar reusa o cache.
const m = vi.hoisted(() => ({
  getResumoFinanceiro: vi.fn(),
  getAgingReceber: vi.fn(),
  getDRE: vi.fn(),
  getTopInadimplentes: vi.fn(),
  getProjecaoSnapshotsCockpit: vi.fn(),
  getBalancoInputs: vi.fn(),
  getNcgNaJanela: vi.fn(),
}));
vi.mock('@/services/financeiroService', () => ({
  getResumoFinanceiro: m.getResumoFinanceiro,
  getAgingReceber: m.getAgingReceber,
  getDRE: m.getDRE,
  getTopInadimplentes: m.getTopInadimplentes,
}));
vi.mock('@/services/financeiroV2Service', () => ({
  getProjecaoSnapshotsCockpit: m.getProjecaoSnapshotsCockpit,
  getBalancoInputs: m.getBalancoInputs,
  getNcgNaJanela: m.getNcgNaJanela,
}));
vi.mock('@/integrations/supabase/client', () => {
  const b = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
  return { supabase: { from: () => b } };
});
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useFinanceiroCockpit } from '../useFinanceiroCockpit';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';

const resumoEmpresa = (cr: number, cp: number, venc: number) => ({
  contas_correntes: [], saldo_total_cc: 100, total_a_receber: cr, total_a_pagar: cp,
  total_vencido_receber: venc, total_vencido_pagar: 0, posicao_liquida: cr - cp, titulos_motivo: null,
});
const resumoSemTitulos = (motivo: string) => ({
  contas_correntes: [], saldo_total_cc: 100, total_a_receber: null, total_a_pagar: null,
  total_vencido_receber: null, total_vencido_pagar: null, posicao_liquida: null, titulos_motivo: motivo,
});

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const novoClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('financeiroRegime', 'competencia');
  m.getResumoFinanceiro.mockResolvedValue({
    oben: resumoEmpresa(1000, 400, 100), colacor: resumoEmpresa(500, 100, 0), colacor_sc: resumoEmpresa(0, 0, 0),
  });
  m.getAgingReceber.mockResolvedValue(null);
  m.getDRE.mockResolvedValue([]);
  m.getTopInadimplentes.mockResolvedValue([]);
  m.getProjecaoSnapshotsCockpit.mockResolvedValue([]);
  m.getBalancoInputs.mockResolvedValue({});
  m.getNcgNaJanela.mockResolvedValue([]);
});

describe('useFinanceiroCockpit (react-query)', () => {
  it('resumo ok: totais e inadimplência a partir das 3 empresas', async () => {
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(novoClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.totalCR).toBe(1500);
    expect(result.current.totalCP).toBe(500);
    expect(result.current.totalVencidoCR).toBe(100);
    expect(result.current.pctInadimplencia).toBeCloseTo((100 / 1500) * 100);
    expect(result.current.totalCC).toBe(300);
  });

  it('resumo que falha → totais e inadimplência null (nunca 0); os outros blocos seguem', async () => {
    m.getResumoFinanceiro.mockRejectedValue(new Error('saldo de títulos indisponível (colacor): sem_acesso'));
    m.getTopInadimplentes.mockResolvedValue([{ cliente: 'X', valor: 10 }]);
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(novoClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.totalCR).toBeNull();
    expect(result.current.totalCP).toBeNull();
    expect(result.current.totalVencidoCR).toBeNull();
    expect(result.current.pctInadimplencia).toBeNull();
    expect(result.current.totalCC).toBeNull();
    expect(result.current.riscoLiquidez).toBeNull();
    expect(result.current.inadimplentes).toHaveLength(1);
  });

  it('títulos de UM CNPJ indisponíveis → CR/CP/inadimplência do grupo null, mas o caixa segue', async () => {
    m.getResumoFinanceiro.mockResolvedValue({
      oben: resumoEmpresa(1000, 400, 100), colacor: resumoSemTitulos('saldo de títulos indisponível (colacor): sem_acesso'),
      colacor_sc: resumoEmpresa(0, 0, 0),
    });
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(novoClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.totalCR).toBeNull();
    expect(result.current.totalCP).toBeNull();
    expect(result.current.totalVencidoCR).toBeNull();
    expect(result.current.pctInadimplencia).toBeNull();
    expect(result.current.riscoLiquidez).toBeNull();
    expect(result.current.totalCC).toBe(300);
  });

  it('DRE que falha → margens null, sem derrubar o resumo', async () => {
    m.getDRE.mockRejectedValue(new Error('dre off'));
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(novoClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.margemBruta).toBeNull();
    expect(result.current.margemOp).toBeNull();
    expect(result.current.totalCR).toBe(1500);
  });

  it('remontar reusa o cache: nenhuma leitura nova dentro do staleTime', async () => {
    const qc = novoClient();
    const a = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    a.unmount();
    const b = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(qc) });
    expect(b.result.current.loading).toBe(false);
    expect(m.getResumoFinanceiro).toHaveBeenCalledTimes(1);
    expect(m.getDRE).toHaveBeenCalledTimes(3);
  });

  it('trocar o regime refaz só a DRE (resumo/aging/inadimplentes ficam no cache)', async () => {
    const { result } = renderHook(
      () => ({ c: useFinanceiroCockpit(), r: useFinanceiroRegime() }),
      { wrapper: wrapper(novoClient()) },
    );
    await waitFor(() => expect(result.current.c.loading).toBe(false));
    expect(m.getDRE).toHaveBeenCalledTimes(3);
    act(() => result.current.r.setRegime('caixa'));
    await waitFor(() => expect(m.getDRE).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(result.current.c.loading).toBe(false));
    expect(result.current.c.regime).toBe('caixa');
    expect(m.getDRE.mock.calls.slice(3).every((c) => c[3] === 'caixa')).toBe(true);
    expect(m.getResumoFinanceiro).toHaveBeenCalledTimes(1);
    expect(m.getAgingReceber).toHaveBeenCalledTimes(1);
    expect(m.getTopInadimplentes).toHaveBeenCalledTimes(1);
  });

  it('falha transitória: o retry do react-query recupera o bloco (o erro não vira "sucesso" no cache)', async () => {
    // Antes o catch DENTRO da queryFn resolvia null: o retry nunca disparava e o null ficava 60 s no cache.
    m.getResumoFinanceiro.mockRejectedValueOnce(new Error('timeout'));
    m.getAgingReceber.mockRejectedValueOnce(new Error('timeout'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0, staleTime: 60_000 } } });
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(m.getResumoFinanceiro).toHaveBeenCalledTimes(2);
    expect(result.current.totalCR).toBe(1500);
    expect(m.getAgingReceber).toHaveBeenCalledTimes(2);
  });

  it('bloco que falhou é relido ao remontar (erro não é cacheado como dado)', async () => {
    m.getResumoFinanceiro.mockRejectedValueOnce(new Error('off'));
    const qc = novoClient();
    const a = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    expect(a.result.current.totalCR).toBeNull();
    a.unmount();
    const b = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(b.result.current.totalCR).toBe(1500));
    expect(m.getResumoFinanceiro).toHaveBeenCalledTimes(2);
  });

  it('snapshots que falham → empresas ausentes (parcial), nunca NCG "saudável"', async () => {
    m.getProjecaoSnapshotsCockpit.mockRejectedValue(new Error('off'));
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(novoClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cockpit.parcial).toBe(true);
    expect(result.current.cockpit.empresas_presentes).toEqual([]);
  });

  it('recarregar invalida todos os blocos', async () => {
    const qc = novoClient();
    const { result } = renderHook(() => useFinanceiroCockpit(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.recarregar(); });
    expect(m.getResumoFinanceiro).toHaveBeenCalledTimes(2);
    expect(m.getAgingReceber).toHaveBeenCalledTimes(2);
  });
});
