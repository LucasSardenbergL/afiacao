import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const estado = vi.hoisted(() => ({ chamadas: 0 }));

vi.mock('@/integrations/supabase/client', () => {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    is: () => cadeia,
    gt: () => cadeia,
    order: () => cadeia,
    limit: () => cadeia,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    supabase: {
      from: (tabela: string) => {
        if (tabela !== 'fin_period_overrides') throw new Error(`tabela inesperada: ${tabela}`);
        estado.chamadas += 1;
        return cadeia;
      },
      functions: { invoke: vi.fn() },
    },
  };
});

import { usePeriodOverride } from '../usePeriodOverride';

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('usePeriodOverride', () => {
  beforeEach(() => {
    estado.chamadas = 0;
  });

  it('exports openOverride and activeOverride', () => {
    const { result } = renderHook(() => usePeriodOverride('colacor'), { wrapper });
    expect(typeof result.current.openOverride).toBe('object'); // useMutation returns object
    expect('activeOverride' in result.current).toBe(true);
  });

  it('sem o gate (default) consulta o override ativo', async () => {
    renderHook(() => usePeriodOverride('colacor'), { wrapper });
    await waitFor(() => expect(estado.chamadas).toBe(1));
  });

  it('gate desligado (cliente no topbar) não consulta — a RLS só deixa staff ler', async () => {
    renderHook(() => usePeriodOverride('colacor', { habilitado: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(estado.chamadas).toBe(0);
  });
});
