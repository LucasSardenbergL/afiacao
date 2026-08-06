import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useAuthzContract } from '@/hooks/useAuthzContract';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

let qc: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

/**
 * Versão do contrato de autorização vigente no banco (E2/FU4).
 *
 * O ponto inteiro deste hook é ser fail-closed: no Lovable a migration é aplicada à mão e falha
 * em silêncio, então o app não pode assumir que a matriz de capability existe — tem de perguntar.
 */
describe('useAuthzContract', () => {
  it('v2 no banco ⇒ matriz ativa', async () => {
    rpcMock.mockResolvedValue({ data: 2, error: null });
    const { result } = renderHook(() => useAuthzContract(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.version).toBe(2);
    expect(result.current.matrizAtiva).toBe(true);
  });

  it('v1 no banco ⇒ matriz inativa (contrato antigo ainda vigente)', async () => {
    rpcMock.mockResolvedValue({ data: 1, error: null });
    const { result } = renderHook(() => useAuthzContract(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.matrizAtiva).toBe(false);
  });

  it('RPC ausente (migration não aplicada) ⇒ matriz inativa', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    const { result } = renderHook(() => useAuthzContract(), { wrapper });
    // timeout ampliado: o hook usa `retry: 1`, então `loading` só assenta depois do backoff.
    // Esperamos assentar de propósito — provar "false durante o loading" seria trivial.
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 5000 });

    expect(result.current.matrizAtiva).toBe(false);
    expect(result.current.version).toBe(1);
  });

  it('durante o carregamento ⇒ matriz inativa (não é otimista)', () => {
    rpcMock.mockReturnValue(new Promise(() => {})); // nunca resolve
    const { result } = renderHook(() => useAuthzContract(), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.matrizAtiva).toBe(false);
  });

  /**
   * O furo apanhado pela revisão adversária do Codex: o react-query PRESERVA o último `data`
   * bem-sucedido quando um refetch falha. Sem checar `isError`, uma sessão que leu v2 e depois
   * perdeu a RPC — migration revertida, rollback, queda de rede — seguiria concedendo capability
   * gerencial com base num cache obsoleto. Este teste é o que impede a regressão.
   */
  it('sucesso seguido de ERRO no refetch ⇒ volta a inativa (não fica preso no cache)', async () => {
    rpcMock.mockResolvedValue({ data: 2, error: null });
    const { result } = renderHook(() => useAuthzContract(), { wrapper });
    await waitFor(() => expect(result.current.matrizAtiva).toBe(true));

    // a RPC some (ex.: migration revertida) e a query é refeita
    rpcMock.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    await qc.refetchQueries({ queryKey: ['authz-contract-version'] });

    await waitFor(() => expect(result.current.matrizAtiva).toBe(false));
  });
});
