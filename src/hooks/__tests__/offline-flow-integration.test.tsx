/**
 * Teste de integração do ciclo offline→reconnect do picking, exercitando o caminho
 * REAL: offline-queue (localStorage) + registerAllOfflineHandlers + useOfflineFlush
 * + confirmPickItem. Só o cliente Supabase é mockado. Substitui (deterministicamente)
 * a parte do QA de browser que fica atrás de auth/seed de dados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));

import { supabase } from '@/integrations/supabase/client';
import { enqueue, getOfflineQueueDepth } from '@/lib/offline-queue';
import { registerAllOfflineHandlers } from '@/lib/offline-handlers';
import { useOfflineFlush, __clearHandlersForTest } from '@/hooks/useOfflineFlush';
import type { ConfirmPickItemVars } from '@/services/picking-confirm';

const mockedFrom = vi.mocked(supabase.from);

function mockSupabaseOk() {
  const insertFn = vi.fn().mockResolvedValue({ error: null });
  const eqFn = vi.fn().mockResolvedValue({ error: null });
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  mockedFrom.mockImplementation((table: string) =>
    (table === 'picking_events' ? { insert: insertFn } : { update: updateFn }) as never,
  );
  return { insertFn, updateFn, eqFn };
}

const vars: ConfirmPickItemVars = {
  eventId: 'evt-int-1',
  pickingTaskId: 'task-int-1',
  pickingTaskItemId: 'item-int-1',
  userId: 'user-1',
  quantidade: 6,
  quantidadeSeparada: 6,
  loteEsperado: 'LOTE-A',
  loteInformado: 'LOTE-A',
  justificativa: null,
  confirmedAt: '2026-05-24T12:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  __clearHandlersForTest();
  mockedFrom.mockReset();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('ciclo offline→reconnect do picking', () => {
  it('item enfileirado offline é processado no flush e a fila drena', async () => {
    const { insertFn, updateFn } = mockSupabaseOk();

    // 1. Boot do app: registra handlers centrais (como o AppShell faz).
    registerAllOfflineHandlers();

    // 2. Separador confirma item OFFLINE → item entra na fila.
    await enqueue('picking.confirm-item', vars);
    expect(await getOfflineQueueDepth()).toBe(1);

    // 3. Reconecta: montar useOfflineFlush dispara o flush (fila não-vazia + online).
    renderHook(() => useOfflineFlush());

    // 4. O handler processa via confirmPickItem (insert evento + update item) e a fila zera.
    await waitFor(async () => expect(await getOfflineQueueDepth()).toBe(0));
    expect(insertFn).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-int-1', event_type: 'item_confirmado' }));
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({ quantidade_separada: 6, status: 'concluido' }));
  });

  it('handler que falha mantém na fila SEM loop infinito (guard de re-entrância)', async () => {
    // Insert falha com erro não-23505 → confirmPickItem lança → handler retorna false → fica na fila.
    const insertFn = vi.fn().mockResolvedValue({ error: { code: '42501', message: 'rls' } });
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    mockedFrom.mockImplementation((table: string) =>
      (table === 'picking_events'
        ? { insert: insertFn }
        : { update: vi.fn().mockReturnValue({ eq: eqFn }) }) as never,
    );

    registerAllOfflineHandlers();
    await enqueue('picking.confirm-item', vars);

    renderHook(() => useOfflineFlush());

    // Dá tempo do flush rodar; a fila NÃO deve zerar (operação preservada).
    await new Promise((r) => setTimeout(r, 100));
    expect(await getOfflineQueueDepth()).toBe(1);
    // Sem o guard de re-entrância, o re-emit do writeQueue re-dispararia o flush em loop
    // (centenas de chamadas). Com o guard, o handler roda só uma vez por flush.
    expect(insertFn.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
