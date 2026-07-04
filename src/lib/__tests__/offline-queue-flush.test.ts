import { describe, it, expect, beforeEach, vi } from 'vitest';

// track() chama analytics/posthog — neutraliza no teste.
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { enqueue, flush, getOfflineQueueDepth, getQueuedByKind } from '../offline-queue';

beforeEach(() => localStorage.clear());

describe('flush — segurança contra escrita concorrente', () => {
  it('não descarta mutações enfileiradas DURANTE o flush', async () => {
    await enqueue('picking.confirm', { n: 1 });

    // Handler que, no meio do processamento (rede volta e cai de novo), enfileira uma
    // nova mutação — exatamente o cenário do galpão com rede intermitente.
    const handler = vi.fn(async () => {
      await enqueue('picking.confirm', { n: 2 });
      return true; // item 1 processado com sucesso
    });

    await flush(handler);

    // O item 2 (enfileirado durante o flush) NÃO pode ser sobrescrito/perdido.
    expect(await getOfflineQueueDepth()).toBe(1);
    expect(getQueuedByKind<{ n: number }>('picking.confirm')[0].variables).toEqual({ n: 2 });
  });

  it('remove só os processados com sucesso e mantém os que falharam com attempts++', async () => {
    await enqueue('a', { i: 1 });
    await enqueue('a', { i: 2 });

    // 1º item falha (handler retorna false), 2º sucede.
    let call = 0;
    const handler = vi.fn(async () => {
      call += 1;
      return call !== 1; // false no primeiro, true no segundo
    });

    const res = await flush(handler);

    expect(res).toEqual({ success: 1, failed: 1 });
    const remaining = getQueuedByKind<{ i: number }>('a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].variables).toEqual({ i: 1 });
    expect(remaining[0].attempts).toBe(1);
  });
});
