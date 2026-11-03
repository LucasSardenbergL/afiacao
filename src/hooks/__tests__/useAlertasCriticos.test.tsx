import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

/**
 * Plano v5, F4 fatia 1: o shell lia a MESMA contagem de `eventos_outlier` em duas queryKeys
 * (`outlier-pendentes-count` no AppShell e `alertas-criticos-count` no hook) — 2 req/min onde
 * basta 1. Agora os dois badges leem `useAlertasCriticos`, e quem resolve outlier invalida pela
 * constante exportada.
 */

const estado = vi.hoisted(() => ({
  chamadas: 0,
  resposta: { count: 7 as number | null, error: null as null | { message: string } },
}));

vi.mock('@/integrations/supabase/client', () => {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    in: () => Promise.resolve(estado.resposta),
  };
  return {
    supabase: {
      from: (tabela: string) => {
        if (tabela !== 'eventos_outlier') throw new Error(`tabela inesperada: ${tabela}`);
        estado.chamadas += 1;
        return cadeia;
      },
    },
  };
});

import { CHAVE_OUTLIER_PENDENTES_COUNT, useAlertasCriticos } from '../useAlertasCriticos';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

describe('useAlertasCriticos — contagem única do shell', () => {
  beforeEach(() => {
    estado.chamadas = 0;
    estado.resposta = { count: 7, error: null };
  });

  it('dois consumidores (os dois badges) compartilham UMA requisição', async () => {
    const { wrapper } = montar();
    const { result } = renderHook(() => [useAlertasCriticos(true), useAlertasCriticos(true)], { wrapper });
    await waitFor(() => expect(result.current[0].data).toBe(7));
    expect(result.current[1].data).toBe(7);
    expect(estado.chamadas).toBe(1);
  });

  it('a invalidação pela constante (AdminReposicaoAlertas) refaz a contagem', async () => {
    const { qc, wrapper } = montar();
    const { result } = renderHook(() => useAlertasCriticos(true), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(7));
    estado.resposta = { count: 3, error: null };
    await act(() => qc.invalidateQueries({ queryKey: CHAVE_OUTLIER_PENDENTES_COUNT }));
    await waitFor(() => expect(result.current.data).toBe(3));
    expect(estado.chamadas).toBe(2);
  });

  it('erro da leitura vira null (badge oculto), nunca 0 fabricado', async () => {
    estado.resposta = { count: null, error: { message: 'permission denied' } };
    const { wrapper } = montar();
    const { result } = renderHook(() => useAlertasCriticos(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('gate desligado (customer/sales-only) não consulta', async () => {
    const { wrapper } = montar();
    renderHook(() => useAlertasCriticos(false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(estado.chamadas).toBe(0);
  });
});
