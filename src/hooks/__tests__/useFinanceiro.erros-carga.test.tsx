import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Falha de LEITURA vira erro POR DATASET (`errosCarga`) e limpa o dado daquele dataset:
 * o `error` global acusava a aba errada e não sumia com a recarga bem-sucedida.
 * `error` fica só para AÇÕES (sync/calcular).
 */

const m = vi.hoisted(() => ({
  triggerFinanceiroSync: vi.fn(),
  getResumoFinanceiro: vi.fn(),
  getContasPagar: vi.fn(),
  getContasReceber: vi.fn(),
  getAgingReceber: vi.fn(),
  getAgingPagar: vi.fn(),
  getDRE: vi.fn(),
  getFluxoCaixa: vi.fn(),
  getTopInadimplentes: vi.fn(),
  getLastSyncTime: vi.fn(),
}));
vi.mock('@/services/financeiroService', () => m);

import { useFinanceiro } from '../useFinanceiro';

const resumoDe = (empresa: string) => ({
  contas_correntes: [],
  saldo_total_cc: 10,
  total_a_receber: 1,
  total_a_pagar: 1,
  total_vencido_receber: 0,
  total_vencido_pagar: 0,
  posicao_liquida: 0,
  empresa,
});

describe('useFinanceiro — errosCarga por dataset', () => {
  beforeEach(() => {
    Object.values(m).forEach((f) => f.mockReset());
    m.getLastSyncTime.mockResolvedValue(null);
  });

  it('falha em loadContasPagar limpa o dado, marca o dataset e não toca o error global', async () => {
    m.getContasPagar.mockResolvedValueOnce({ rows: [{ id: 1 }], total: 1 });
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadContasPagar(); });
    expect(result.current.contasPagar).toHaveLength(1);

    m.getContasPagar.mockRejectedValueOnce(new Error('boom pagar'));
    await act(async () => { await result.current.loadContasPagar(); });
    expect(result.current.errosCarga.contasPagar).toContain('boom pagar');
    expect(result.current.contasPagar).toEqual([]);
    expect(result.current.contasPagarTotal).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('recarga bem-sucedida depois da falha remove a marca do dataset', async () => {
    m.getContasPagar.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadContasPagar(); });
    expect(result.current.errosCarga.contasPagar).toBeDefined();

    m.getContasPagar.mockResolvedValueOnce({ rows: [], total: 0 });
    await act(async () => { await result.current.loadContasPagar(); });
    expect(result.current.errosCarga.contasPagar).toBeUndefined();
  });

  it('falha em loadResumo não acusa o fluxo de caixa (D2)', async () => {
    m.getResumoFinanceiro.mockRejectedValueOnce(new Error('resumo off'));
    m.getFluxoCaixa.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadResumo(); });
    await act(async () => { await result.current.loadFluxoCaixa('2026-01-01', '2026-01-31'); });
    expect(result.current.errosCarga.resumo).toContain('resumo off');
    expect(result.current.errosCarga.fluxoCaixa).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('falha em loadResumo remove só as empresas pedidas naquela carga', async () => {
    m.getResumoFinanceiro.mockResolvedValueOnce({
      oben: resumoDe('oben'),
      colacor: resumoDe('colacor'),
      colacor_sc: resumoDe('colacor_sc'),
    });
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadResumo(); });
    expect(Object.keys(result.current.resumo)).toHaveLength(3);

    act(() => { result.current.setView('oben'); });
    m.getResumoFinanceiro.mockRejectedValueOnce(new Error('oben off'));
    await act(async () => { await result.current.loadResumo(); });
    expect(result.current.resumo.oben).toBeUndefined();
    expect(result.current.resumo.colacor).toBeDefined();
    expect(result.current.errosCarga.resumo).toContain('oben off');
  });

  it('falha em loadAging marca o dataset e deixa o aging null', async () => {
    m.getAgingReceber.mockRejectedValueOnce(new Error('aging off'));
    m.getAgingPagar.mockResolvedValueOnce({});
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadAging(); });
    expect(result.current.errosCarga.aging).toContain('aging off');
    expect(result.current.agingReceber).toBeNull();
    expect(result.current.agingPagar).toBeNull();
  });

  it('falha em syncAll continua no canal global (error)', async () => {
    m.triggerFinanceiroSync.mockRejectedValueOnce(new Error('sync off'));
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.syncAll(); });
    expect(result.current.error).toContain('sync off');
  });
});
