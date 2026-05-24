import { describe, it, expect, beforeEach, vi } from 'vitest';

// track() chama analytics/posthog — neutraliza no teste.
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { getQueuedByKind } from '../offline-queue';

const STORAGE_KEY = 'offline_queue_v1';

beforeEach(() => localStorage.clear());

describe('getQueuedByKind', () => {
  it('retorna [] quando a fila está vazia', () => {
    expect(getQueuedByKind('picking.confirm-item')).toEqual([]);
  });

  it('filtra por kind', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: '1', kind: 'picking.confirm-item', variables: { a: 1 }, enqueuedAt: 'x', attempts: 0 },
      { id: '2', kind: 'recebimento.confirm-unit', variables: { b: 2 }, enqueuedAt: 'x', attempts: 0 },
      { id: '3', kind: 'picking.confirm-item', variables: { a: 3 }, enqueuedAt: 'x', attempts: 0 },
    ]));
    const r = getQueuedByKind<{ a: number }>('picking.confirm-item');
    expect(r).toHaveLength(2);
    expect(r.map((q) => q.variables.a)).toEqual([1, 3]);
  });

  it('tolera localStorage corrompido', () => {
    localStorage.setItem(STORAGE_KEY, '{nope');
    expect(getQueuedByKind('picking.confirm-item')).toEqual([]);
  });
});
