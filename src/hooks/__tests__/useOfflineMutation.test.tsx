import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/offline-queue', () => ({
  enqueue: vi.fn().mockResolvedValue('mock-id'),
}));

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

    expect(mockedEnqueue).toHaveBeenCalledWith('test.action', { foo: 'bar' });
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
    expect(mockedEnqueue).toHaveBeenCalledWith('test.action', { foo: 'bar' });
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
});
