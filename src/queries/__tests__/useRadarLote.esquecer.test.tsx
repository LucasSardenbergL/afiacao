import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConflitoCadastro } from '@/lib/radar/conflito-cadastro';

/**
 * Codex, revisão do código 2026-10-27 (P1, reproduzido): "Esquecer lote" envia ao servidor os conflitos que só esta
 * aba conhece e, no fim, apaga o lote. Sem exclusão mútua, uma retomada no MEIO do envio processava outro item, cujo
 * conflito local o `gravar(null)` do fim apagava — a única evidência. O descarte segura a MESMA trava do runner.
 */
const from = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const deps = vi.hoisted(() => ({
  criarNoOmie: vi.fn(),
  registrarNoRadar: vi.fn(),
  lerEstado: vi.fn(),
  registrarConflito: vi.fn(),
}));
vi.mock('@/queries/useRadarAcoesLead', () => ({ depsCadastroSupabase: deps }));

import { useRadarLoteOmie } from '../useRadarLote';
import { chaveLotePersistido, serializarLote } from '@/lib/radar/lote-persistido';

const CONFLITO: ConflitoCadastro = {
  id: 42, cnpj: '11111111000111', motivo: 'vinculo_divergente', codigoRecebido: '777', codigoVinculado: '555', cnpjDoCodigo: null,
  detalhe: 'x', ocorrencias: 1, versao: 1, ultimaEm: '2026-10-27T15:00:00Z', resolvidoEm: null, notaResolucao: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem(chaveLotePersistido('u1'), serializarLote({
    v: 1, iniciadoEm: '2026-10-27T10:00:00Z', itens: [
      // Conflito que só esta aba conhece (o registro falhou na hora).
      { cnpj: '11111111000111', nome: 'A', estado: { status: 'divergente', motivo: 'vinculo_divergente', erro: 'x', codigo: '777', conflitoId: null } },
      // Pendente: uma retomada o processaria.
      { cnpj: '22222222000122', nome: 'B', estado: { status: 'falha', etapa: 'omie', erro: 'Failed to fetch', codigo: null } },
    ],
  }));
});

async function montarComEnvioPreso() {
  let soltar!: (c: ConflitoCadastro) => void;
  deps.registrarConflito.mockImplementation(() => new Promise<ConflitoCadastro>((r) => { soltar = r; }));
  const h = renderHook(() => useRadarLoteOmie(), { wrapper });
  await waitFor(() => expect(h.result.current.lote?.itens).toHaveLength(2));
  return { h, soltar: (c: ConflitoCadastro) => soltar(c) };
}

describe('useRadarLoteOmie — esquecer com o envio em voo', () => {
  it('uma retomada (mesmo com closure de ANTES do descarte) não roda: nada lido, nada chamado', async () => {
    const { h, soltar } = await montarComEnvioPreso();
    const retomarVelho = h.result.current.retomar; // capturado antes: não vê o `descartando`
    let p!: Promise<{ esquecido: boolean }>;
    act(() => { p = h.result.current.esquecer(); });
    await waitFor(() => expect(deps.registrarConflito).toHaveBeenCalledTimes(1));
    await act(async () => { retomarVelho(); await Promise.resolve(); });
    expect(from).not.toHaveBeenCalled();
    expect(deps.lerEstado).not.toHaveBeenCalled();
    expect(deps.criarNoOmie).not.toHaveBeenCalled();
    await act(async () => { soltar(CONFLITO); await p; });
    await expect(p).resolves.toEqual({ esquecido: true, falhas: [] });
  });

  it('um 2º "Esquecer" no meio do 1º recusa sem reenviar', async () => {
    const { h, soltar } = await montarComEnvioPreso();
    let p1!: Promise<{ esquecido: boolean }>;
    act(() => { p1 = h.result.current.esquecer(); });
    await waitFor(() => expect(h.result.current.descartando).toBe(true));
    let r2: unknown;
    await act(async () => { r2 = await h.result.current.esquecer(); });
    expect(r2).toEqual({ esquecido: false, falhas: [] });
    expect(deps.registrarConflito).toHaveBeenCalledTimes(1);
    await act(async () => { soltar(CONFLITO); await p1; });
  });

  it('envio que FALHA segura o lote (a evidência fica) e libera a trava', async () => {
    deps.registrarConflito.mockRejectedValue(new Error('Failed to fetch'));
    const { result } = renderHook(() => useRadarLoteOmie(), { wrapper });
    await waitFor(() => expect(result.current.lote?.itens).toHaveLength(2));
    let r: unknown;
    await act(async () => { r = await result.current.esquecer(); });
    expect(r).toEqual({ esquecido: false, falhas: [{ cnpj: '11111111000111', erro: 'Failed to fetch' }] });
    expect(result.current.lote?.itens[0].estado.status).toBe('divergente');
    expect(localStorage.getItem(chaveLotePersistido('u1'))).not.toBeNull();
    expect(result.current.descartando).toBe(false);
  });
});
