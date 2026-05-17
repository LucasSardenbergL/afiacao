import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

import { useExtractSpecs } from '../useExtractSpecs';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const fakeResponse = {
  specs: {
    product_code: 'FO20.6827.00',
    product_name: 'Verniz20 PU 6827',
    supplier: 'sayerlack',
    extraction_confidence: 0.9,
    extraction_gaps: [],
    equipamentos_aplicacao: ['pistola_convencional'],
    substrato: ['madeira'],
    certificacoes_aplicaveis: [],
    isento_metais_pesados: [],
    isento_substancias: [],
    diferenciais_chave: ['resistencia_quimica'],
  },
  usage: { inputTokens: 1500, outputTokens: 800, cacheCreationTokens: 0, cacheReadTokens: 0 },
};

describe('useExtractSpecs', () => {
  it('estado inicial: idle', () => {
    const { result } = renderHook(() => useExtractSpecs(), { wrapper });
    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('chama invokeFunction com documentId no payload', async () => {
    invokeMock.mockResolvedValueOnce(fakeResponse);
    const { result } = renderHook(() => useExtractSpecs(), { wrapper });
    result.current.mutate('doc-1');
    await waitFor(() => expect(result.current.data).toEqual(fakeResponse));
    expect(invokeMock).toHaveBeenCalledWith('kb-extract-specs', { documentId: 'doc-1' });
  });

  it('propaga erro pra .error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('quota exceeded'));
    const { result } = renderHook(() => useExtractSpecs(), { wrapper });
    result.current.mutate('doc-1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
