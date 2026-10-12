import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// M-10: o `signOut` não limpava o cache do react-query. Quem entrasse depois no MESMO aparelho via,
// até o refetch, os dados (carteira, títulos, preços) de quem saiu — o cache é do usuário, não do
// navegador. E o `{ error }` do signOut era ignorado: a revogação global falhando deixava a sessão.

type Callback = (event: string, session: unknown) => void;
let aoMudarAuth: Callback | null = null;
const signOut = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((cb: Callback) => {
        aoMudarAuth = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      signOut: (...args: unknown[]) => signOut(...args),
    },
    from: vi.fn(),
  },
}));
vi.mock('@/lib/push/device', () => ({ limparPushDoDevice: vi.fn(() => Promise.resolve()) }));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

const CHAVE = ['carteira', 'usuario-que-saiu'];

function montar() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(CHAVE, { titulos: 42 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useAuth(), { wrapper });
  return { queryClient, result };
}

beforeEach(() => {
  aoMudarAuth = null;
  signOut.mockReset();
  signOut.mockResolvedValue({ error: null });
});

describe('AuthContext — sair limpa o cache do usuário', () => {
  it('signOut() apaga o cache do react-query — o próximo usuário não vê os dados de quem saiu', async () => {
    const { queryClient, result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queryClient.getQueryData(CHAVE)).toEqual({ titulos: 42 });

    await act(async () => {
      await result.current.signOut();
    });

    expect(queryClient.getQueryData(CHAVE)).toBeUndefined();
  });

  it('o evento SIGNED_OUT (outra aba, refresh revogado) também apaga o cache', async () => {
    const { queryClient, result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(aoMudarAuth).not.toBeNull();

    act(() => {
      aoMudarAuth?.('SIGNED_OUT', null);
    });

    expect(queryClient.getQueryData(CHAVE)).toBeUndefined();
  });

  it('revogação global falhando: sai deste navegador (scope local) e limpa o cache mesmo assim', async () => {
    signOut.mockResolvedValueOnce({ error: { message: 'Failed to fetch' } });
    const { queryClient, result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.signOut();
    });

    expect(signOut).toHaveBeenNthCalledWith(2, { scope: 'local' });
    expect(queryClient.getQueryData(CHAVE)).toBeUndefined();
  });
});
