import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CapitalDeGiro } from '@/services/financeiroService';

/**
 * Guard de corrida do usePosicaoAgora (achado codex pós-#722): o load de 'all'
 * pagina ~15 janelas (lento); trocar a empresa durante a carga deixava a
 * resposta VELHA sobrescrever a nova e, com active = data[0], a tela rotulava
 * os números da Oben como Colacor — número errado com selo de empresa errada.
 * Erro também preservava os dados da visão anterior (stale com rótulo novo).
 */

const { getCapitalDeGiroMock } = vi.hoisted(() => ({ getCapitalDeGiroMock: vi.fn() }));
vi.mock('@/services/financeiroService', () => ({ getCapitalDeGiro: getCapitalDeGiroMock }));

import { usePosicaoAgora } from '../usePosicaoAgora';

const giro = (company: string): CapitalDeGiro => ({
  company,
  total_cr_aberto: 100,
  total_cp_aberto: 50,
  saldo_cc: 10,
  capital_giro: 50,
  capital_giro_liquido: 60,
  pmr: null,
  pmp: null,
  ciclo_financeiro: null,
  top5_cr_pct: 0,
  top5_cp_pct: 0,
  entradas_30d: 0,
  saidas_30d: 0,
  saldo_projetado_30d: 10,
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

describe('usePosicaoAgora (guard de corrida e erro)', () => {
  beforeEach(() => {
    getCapitalDeGiroMock.mockReset();
  });

  it('descarta resposta obsoleta: carga lenta de "all" não sobrescreve a empresa selecionada', async () => {
    const dAll = deferred<CapitalDeGiro[]>();
    const dCol = deferred<CapitalDeGiro[]>();
    getCapitalDeGiroMock.mockImplementation((view: string) =>
      view === 'all' ? dAll.promise : dCol.promise,
    );

    const { result } = renderHook(() => usePosicaoAgora()); // monta em 'all' (pendente)
    act(() => {
      result.current.setView('colacor'); // troca ANTES do 'all' resolver
    });

    await act(async () => {
      dCol.resolve([giro('colacor')]); // a carga atual resolve primeiro…
    });
    await act(async () => {
      dAll.resolve([giro('oben'), giro('colacor'), giro('colacor_sc')]); // …e a velha chega depois
    });

    expect(result.current.view).toBe('colacor');
    expect(result.current.data.map((d) => d.company)).toEqual(['colacor']);
    // nunca rotular números da Oben como Colacor
    expect(result.current.active?.company).toBe('colacor');
    expect(result.current.loading).toBe(false);
  });

  it('erro na carga LIMPA os dados (não preserva números da visão anterior)', async () => {
    const dAll = deferred<CapitalDeGiro[]>();
    const dCol = deferred<CapitalDeGiro[]>();
    getCapitalDeGiroMock.mockImplementation((view: string) =>
      view === 'all' ? dAll.promise : dCol.promise,
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => usePosicaoAgora());
    await act(async () => {
      dAll.resolve([giro('oben'), giro('colacor'), giro('colacor_sc')]);
    });
    expect(result.current.data).toHaveLength(3);

    act(() => {
      result.current.setView('colacor');
    });
    await act(async () => {
      dCol.reject(new Error('RLS negou'));
    });

    expect(result.current.data).toEqual([]); // sem stale com rótulo novo — tela mostra "Sem dados"
    expect(result.current.active).toBeNull();
    expect(result.current.loading).toBe(false);
    errSpy.mockRestore();
  });

  it('caminho feliz: view específica usa a linha da própria empresa como active', async () => {
    getCapitalDeGiroMock.mockResolvedValue([giro('oben')]);

    const { result } = renderHook(() => usePosicaoAgora());
    await act(async () => {}); // resolve o load inicial ('all')
    act(() => {
      result.current.setView('oben');
    });
    await act(async () => {}); // resolve o load do 'oben'

    expect(result.current.active?.company).toBe('oben');
    expect(result.current.loading).toBe(false);
  });
});
