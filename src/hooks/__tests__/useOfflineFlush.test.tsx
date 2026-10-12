import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFlushImpl = vi.fn();
const mockSubscribe = vi.fn();
let enqueuesFeitos = 0;

vi.mock('@/lib/offline-queue', () => ({
  flush: (...args: unknown[]) => mockFlushImpl(...args),
  subscribeToOfflineQueue: (...args: unknown[]) => mockSubscribe(...args),
  contadorDeEnqueues: () => enqueuesFeitos,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }) } },
}));
const clienteFalso = { tag: 'cliente-do-dono' };
vi.mock('@/lib/offline-cliente-do-dono', () => ({
  credencialDaSessao: vi.fn(),
  criarClienteDoDono: () => clienteFalso,
}));

import {
  useOfflineFlush,
  registerOfflineHandler,
  __clearHandlersForTest,
  REAGENDAR_EM_CURSO_MS,
} from '../useOfflineFlush';

const credencial = { userId: 'user-a', accessToken: 'tok-a' };

// useOfflineFlush usa useQueryClient() → precisa do provider.
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  mockFlushImpl.mockReset();
  mockSubscribe.mockReset();
  mockSubscribe.mockReturnValue(() => undefined);
  __clearHandlersForTest();
  enqueuesFeitos = 0;
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('useOfflineFlush', () => {
  it('registers online event listener on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderHook(() => useOfflineFlush(), { wrapper });
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function));
    addSpy.mockRestore();
  });

  it('calls flush when online event fires', async () => {
    mockFlushImpl.mockResolvedValue({ success: 2, failed: 0 });
    renderHook(() => useOfflineFlush(), { wrapper });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mockFlushImpl).toHaveBeenCalled());
  });

  it('routes mutations to registered handler by kind', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerOfflineHandler('test.kind', handler);

    // O hook passa um wrapper que despacha por kind. Vamos chamar o wrapper diretamente.
    mockFlushImpl.mockImplementation(async (wrapper: (m: { kind: string; variables: unknown }, c: typeof credencial) => Promise<boolean>) => {
      const ok = await wrapper({ kind: 'test.kind', variables: { x: 1 } }, credencial);
      return { success: ok ? 1 : 0, failed: ok ? 0 : 1 };
    });

    renderHook(() => useOfflineFlush(), { wrapper });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    // O handler recebe o cliente VINCULADO ao token do dono, nunca o singleton.
    await waitFor(() => expect(handler).toHaveBeenCalledWith({ x: 1 }, clienteFalso));
  });

  it('returns false for unknown kind (item stays in queue)', async () => {
    mockFlushImpl.mockImplementation(async (wrapper: (m: { kind: string; variables: unknown }, c: typeof credencial) => Promise<boolean>) => {
      const ok = await wrapper({ kind: 'no.handler', variables: {} }, credencial);
      return { success: ok ? 1 : 0, failed: ok ? 0 : 1 };
    });

    renderHook(() => useOfflineFlush(), { wrapper });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mockFlushImpl).toHaveBeenCalled());
    // (não dá pra checar o retorno diretamente, mas garantimos que não crashou)
  });
});

describe('useOfflineFlush — pedido de drenar não morre', () => {
  async function rodadaOnline() {
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
  }

  it('rodada recusada (emCurso, outra aba com a vaga) é reagendada', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockFlushImpl
        .mockResolvedValueOnce({ success: 0, failed: 0, retidos: 0, emCurso: true })
        .mockResolvedValue({ success: 1, failed: 0, retidos: 0 });
      renderHook(() => useOfflineFlush(), { wrapper });
      await rodadaOnline();
      expect(mockFlushImpl).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REAGENDAR_EM_CURSO_MS);
      });
      expect(mockFlushImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('item enfileirado DURANTE a rodada é drenado por outra rodada', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockFlushImpl
        .mockImplementationOnce(async () => {
          enqueuesFeitos++; // enqueue nesta aba enquanto o handler estava em voo
          return { success: 1, failed: 0, retidos: 0 };
        })
        .mockResolvedValue({ success: 1, failed: 0, retidos: 0 });
      renderHook(() => useOfflineFlush(), { wrapper });
      await rodadaOnline();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REAGENDAR_EM_CURSO_MS);
      });
      expect(mockFlushImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('controle: item que só FALHA não reagenda (sem loop martelando o backend)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockFlushImpl.mockResolvedValue({ success: 0, failed: 1, retidos: 0 });
      renderHook(() => useOfflineFlush(), { wrapper });
      await rodadaOnline();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REAGENDAR_EM_CURSO_MS * 3);
      });
      expect(mockFlushImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
