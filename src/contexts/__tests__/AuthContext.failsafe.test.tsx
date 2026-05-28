import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

// Supabase auth que NUNCA resolve: getSession pendente pra sempre e nenhum
// evento de auth disparado. Reproduz a trava de bootstrap (lock do
// navigator.locks preso, token corrompido, request pendurado). Sem o failsafe,
// `loading` ficaria true pra sempre → ProtectedRoute gira eternamente e o login
// nunca aparece.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      getSession: vi.fn(() => new Promise(() => {})),
    },
    from: vi.fn(),
  },
}));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('AuthContext loading failsafe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('força loading=false após o timeout quando o bootstrap de auth trava', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    // Bootstrap pendente: ainda carregando.
    expect(result.current.loading).toBe(true);

    // Antes do failsafe (10s): segue carregando — prova que é o timer que
    // destrava, não outro caminho.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(result.current.loading).toBe(true);

    // Após o failsafe: loading vira false → ProtectedRoute redireciona pro /auth.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
  });
});
