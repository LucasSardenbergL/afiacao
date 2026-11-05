import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * F8 do plano v6 (DRE-IO): o DRE consolidado carregava as 3 empresas em SÉRIE
 * (espera t1+t2+t3). Agora as 3 leituras começam juntas (espera = max), preservando:
 *  - a ORDEM fixa oben → colacor → colacor_sc no array concatenado, qualquer que seja a
 *    ordem em que as respostas chegam;
 *  - a FALHA INTEGRAL: uma empresa rejeitou → nada de DRE parcial como se fosse o grupo;
 *  - a geração `dre`: só a última carga publica.
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

type Linha = { company: string; mes: number; tag?: string };

function adiado<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const linhas = (co: string, tag?: string): Linha[] => [
  { company: co, mes: 1, tag },
  { company: co, mes: 2, tag },
];

/** Escoa microtarefas sem resolver nenhuma leitura pendente. */
const escoar = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('useFinanceiro.loadDRE — consolidado em paralelo', () => {
  beforeEach(() => {
    Object.values(m).forEach((f) => f.mockReset());
    m.getLastSyncTime.mockResolvedValue(null);
  });

  it('as 3 leituras começam ANTES de qualquer uma resolver', async () => {
    const pend = { oben: adiado<Linha[]>(), colacor: adiado<Linha[]>(), colacor_sc: adiado<Linha[]>() };
    m.getDRE.mockImplementation((co: keyof typeof pend) => pend[co].promise);
    const { result } = renderHook(() => useFinanceiro('all'));

    let carga!: Promise<void>;
    act(() => { carga = result.current.loadDRE(2026, undefined, 'competencia'); });
    await escoar();

    // Nenhuma resolveu ainda — no laço serial só a 1ª teria sido chamada.
    expect(m.getDRE).toHaveBeenCalledTimes(3);
    expect(m.getDRE.mock.calls.map((c) => c[0])).toEqual(['oben', 'colacor', 'colacor_sc']);
    expect(m.getDRE.mock.calls.every((c) => c[1] === 2026 && c[3] === 'competencia')).toBe(true);

    await act(async () => {
      pend.oben.resolve(linhas('oben'));
      pend.colacor.resolve(linhas('colacor'));
      pend.colacor_sc.resolve(linhas('colacor_sc'));
      await carga;
    });
  });

  it('ordem FIXA oben → colacor → colacor_sc mesmo com respostas fora de ordem', async () => {
    const pend = { oben: adiado<Linha[]>(), colacor: adiado<Linha[]>(), colacor_sc: adiado<Linha[]>() };
    m.getDRE.mockImplementation((co: keyof typeof pend) => pend[co].promise);
    const { result } = renderHook(() => useFinanceiro('all'));

    let carga!: Promise<void>;
    act(() => { carga = result.current.loadDRE(2026); });
    await escoar();
    await act(async () => {
      pend.colacor_sc.resolve(linhas('colacor_sc'));
      await escoar();
      pend.colacor.resolve(linhas('colacor'));
      await escoar();
      pend.oben.resolve(linhas('oben'));
      await carga;
    });

    expect(result.current.errosCarga.dre).toBeUndefined();
    expect((result.current.dre as unknown as Linha[]).map((l) => `${l.company}:${l.mes}`)).toEqual([
      'oben:1', 'oben:2', 'colacor:1', 'colacor:2', 'colacor_sc:1', 'colacor_sc:2',
    ]);
  });

  it('FALHA INTEGRAL: uma empresa rejeita → DRE vazio + erro, nunca parcial', async () => {
    m.getDRE.mockImplementation((co: string) =>
      co === 'colacor' ? Promise.reject(new Error('dre colacor off')) : Promise.resolve(linhas(co)),
    );
    const { result } = renderHook(() => useFinanceiro('all'));

    await act(async () => { await result.current.loadDRE(2026); });

    expect(result.current.dre).toEqual([]);
    expect(result.current.errosCarga.dre).toContain('dre colacor off');
    expect(result.current.loading).toBe(false);
  });

  it('geração: resposta da carga VELHA não sobrescreve a nova', async () => {
    const velha = { oben: adiado<Linha[]>(), colacor: adiado<Linha[]>(), colacor_sc: adiado<Linha[]>() };
    m.getDRE.mockImplementation((co: keyof typeof velha) => velha[co].promise);
    const { result } = renderHook(() => useFinanceiro('all'));

    let cargaVelha!: Promise<void>;
    act(() => { cargaVelha = result.current.loadDRE(2025); });
    await escoar();

    m.getDRE.mockImplementation((co: string) => Promise.resolve(linhas(co, 'nova')));
    await act(async () => { await result.current.loadDRE(2026); });

    await act(async () => {
      velha.oben.resolve(linhas('oben', 'velha'));
      velha.colacor.resolve(linhas('colacor', 'velha'));
      velha.colacor_sc.resolve(linhas('colacor_sc', 'velha'));
      await cargaVelha;
    });

    const dre = result.current.dre as unknown as Linha[];
    expect(dre).toHaveLength(6);
    expect(dre.every((l) => l.tag === 'nova')).toBe(true);
  });
});
