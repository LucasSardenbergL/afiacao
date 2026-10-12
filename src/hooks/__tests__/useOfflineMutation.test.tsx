import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/offline-queue', () => ({
  enqueue: vi.fn().mockResolvedValue('mock-id'),
}));

// Identidade REAL (useAuth().user) — é ela que vira o dono do item da fila.
const authState = vi.hoisted(() => ({ user: { id: 'user-real' } as { id: string } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: authState.user }) }));

import { enqueue } from '@/lib/offline-queue';
import { useOfflineMutation } from '../useOfflineMutation';

const mockedEnqueue = vi.mocked(enqueue);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockedEnqueue.mockClear();
  authState.user = { id: 'user-real' };
  // Default online
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('useOfflineMutation', () => {
  it('runs mutationFn directly when online + success', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ foo: 'bar' });
    });

    expect(mutationFn).toHaveBeenCalledWith({ foo: 'bar' });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(false);
  });

  it('enqueues when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const mutationFn = vi.fn();
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ foo: 'bar' });
    });

    expect(mockedEnqueue).toHaveBeenCalledWith('test.action', { foo: 'bar' }, 'user-real');
    expect(mutationFn).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(true);
  });

  it('enqueues when online but network error thrown', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new TypeError('NetworkError when attempting to fetch'));
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ foo: 'bar' });
    });

    expect(mutationFn).toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalledWith('test.action', { foo: 'bar' }, 'user-real');
    expect(result.current.queued).toBe(true);
  });

  it('does NOT enqueue when online + non-network error (lets it throw)', async () => {
    const err = new Error('Validation failed');
    const mutationFn = vi.fn().mockRejectedValue(err);
    const { result } = renderHook(
      () =>
        useOfflineMutation({
          kind: 'test.action',
          mutationFn,
        }),
      { wrapper },
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({ foo: 'bar' });
      } catch {
        /* expected */
      }
    });

    expect(mutationFn).toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  describe('sem usuário (sessão caiu): nunca diz "salvo offline"', () => {
    it('offline imediato → NÃO enfileira e lança', async () => {
      authState.user = null;
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      const mutationFn = vi.fn();
      const { result } = renderHook(() => useOfflineMutation({ kind: 'test.action', mutationFn }), { wrapper });

      let erro: unknown;
      await act(async () => {
        try { await result.current.mutateAsync({ foo: 'bar' }); } catch (e) { erro = e; }
      });

      expect(String(erro)).toContain('sem sessão');
      expect(mockedEnqueue).not.toHaveBeenCalled();
      expect(result.current.queued).toBe(false);
    });

    it('falha de rede online → NÃO enfileira e propaga o erro ORIGINAL', async () => {
      authState.user = null;
      const original = new TypeError('Failed to fetch');
      const mutationFn = vi.fn().mockRejectedValue(original);
      const { result } = renderHook(() => useOfflineMutation({ kind: 'test.action', mutationFn }), { wrapper });

      let erro: unknown;
      await act(async () => {
        try { await result.current.mutateAsync({ foo: 'bar' }); } catch (e) { erro = e; }
      });

      expect(erro).toBe(original);
      expect(mockedEnqueue).not.toHaveBeenCalled();
      expect(result.current.queued).toBe(false);
    });
  });
});
