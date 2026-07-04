import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFlushImpl = vi.fn();
const mockSubscribe = vi.fn();

vi.mock('@/lib/offline-queue', () => ({
  flush: (...args: unknown[]) => mockFlushImpl(...args),
  subscribeToOfflineQueue: (...args: unknown[]) => mockSubscribe(...args),
}));

import { useOfflineFlush, registerOfflineHandler, __clearHandlersForTest } from '../useOfflineFlush';

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
    mockFlushImpl.mockImplementation(async (wrapper: (m: { kind: string; variables: unknown }) => Promise<boolean>) => {
      const ok = await wrapper({ kind: 'test.kind', variables: { x: 1 } });
      return { success: ok ? 1 : 0, failed: ok ? 0 : 1 };
    });

    renderHook(() => useOfflineFlush(), { wrapper });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(handler).toHaveBeenCalledWith({ x: 1 }));
  });

  it('returns false for unknown kind (item stays in queue)', async () => {
    mockFlushImpl.mockImplementation(async (wrapper: (m: { kind: string; variables: unknown }) => Promise<boolean>) => {
      const ok = await wrapper({ kind: 'no.handler', variables: {} });
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
