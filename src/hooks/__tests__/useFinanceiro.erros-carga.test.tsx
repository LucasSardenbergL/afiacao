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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useFinanceiro — cargas concorrentes do mesmo dataset (guard de geração)', () => {
  beforeEach(() => {
    Object.values(m).forEach((f) => f.mockReset());
    m.getLastSyncTime.mockResolvedValue(null);
  });

  it('contasPagar (a): carga VELHA que falha depois da NOVA com sucesso não apaga a lista boa', async () => {
    const d1 = deferred<{ rows: unknown[]; total: number }>();
    m.getContasPagar
      .mockImplementationOnce(() => d1.promise)
      .mockResolvedValueOnce({ rows: [{ id: 1 }], total: 1 });
    const { result } = renderHook(() => useFinanceiro('all'));
    let p1!: Promise<void>;
    act(() => { p1 = result.current.loadContasPagar(); });
    await act(async () => { await result.current.loadContasPagar(); });
    expect(result.current.contasPagar).toHaveLength(1);

    await act(async () => { d1.reject(new Error('velha falhou')); await p1; });
    expect(result.current.contasPagar).toHaveLength(1);
    expect(result.current.errosCarga.contasPagar).toBeUndefined();
  });

  it('contasPagar (b): carga VELHA com sucesso depois da NOVA que falhou não apaga o erro atual', async () => {
    const d1 = deferred<{ rows: unknown[]; total: number }>();
    m.getContasPagar
      .mockImplementationOnce(() => d1.promise)
      .mockRejectedValueOnce(new Error('nova falhou'));
    const { result } = renderHook(() => useFinanceiro('all'));
    let p1!: Promise<void>;
    act(() => { p1 = result.current.loadContasPagar(); });
    await act(async () => { await result.current.loadContasPagar(); });
    expect(result.current.errosCarga.contasPagar).toContain('nova falhou');

    await act(async () => { d1.resolve({ rows: [{ id: 9 }], total: 1 }); await p1; });
    expect(result.current.contasPagar).toEqual([]);
    expect(result.current.errosCarga.contasPagar).toContain('nova falhou');
  });

  it('aging (m1): carga VELHA que rejeita depois da NOVA não marca erro nem apaga o aging novo', async () => {
    const d1 = deferred<unknown>();
    const novo = { total: 5 };
    m.getAgingReceber
      .mockImplementationOnce(() => d1.promise)
      .mockResolvedValueOnce(novo);
    m.getAgingPagar.mockResolvedValue(novo);
    const { result } = renderHook(() => useFinanceiro('all'));
    let p1!: Promise<void>;
    act(() => { p1 = result.current.loadAging(); });
    await act(async () => { await result.current.loadAging(); });
    expect(result.current.agingReceber).toEqual(novo);

    await act(async () => { d1.reject(new Error('aging velho')); await p1; });
    expect(result.current.errosCarga.aging).toBeUndefined();
    expect(result.current.agingReceber).toEqual(novo);
  });

  it('DRE consolidado (m2): uma empresa falha → dre vazio (sem soma parcial) e erro marcado', async () => {
    m.getDRE.mockImplementation(async (co: string) => {
      if (co === 'colacor') throw new Error('dre colacor off');
      return [{ company: co, mes: 1 }];
    });
    const { result } = renderHook(() => useFinanceiro('all'));
    await act(async () => { await result.current.loadDRE(2026); });
    expect(result.current.dre).toEqual([]);
    expect(result.current.errosCarga.dre).toContain('dre colacor off');
  });
});
