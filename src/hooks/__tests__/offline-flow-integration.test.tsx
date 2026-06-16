/**
 * Teste de integração do ciclo offline→reconnect do picking, exercitando o caminho
 * REAL: offline-queue (localStorage) + registerAllOfflineHandlers + useOfflineFlush
 * + confirmPickItem. Só o cliente Supabase é mockado. Substitui (deterministicamente)
 * a parte do QA de browser que fica atrás de auth/seed de dados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import { supabase } from '@/integrations/supabase/client';
import { enqueue, getOfflineQueueDepth } from '@/lib/offline-queue';
import { registerAllOfflineHandlers } from '@/lib/offline-handlers';
import { useOfflineFlush, __clearHandlersForTest } from '@/hooks/useOfflineFlush';
import type { ConfirmPickItemVars } from '@/services/picking-confirm';

const mockedRpc = vi.mocked((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc);

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
  mockedRpc.mockReset();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('ciclo offline→reconnect do picking', () => {
  it('item enfileirado offline é processado no flush e a fila drena', async () => {
    mockedRpc.mockResolvedValue({ error: null });

    // 1. Boot do app: registra handlers centrais (como o AppShell faz).
    registerAllOfflineHandlers();

    // 2. Separador confirma item OFFLINE → item entra na fila.
    await enqueue('picking.confirm-item', vars);
    expect(await getOfflineQueueDepth()).toBe(1);

    // 3. Reconecta: montar useOfflineFlush dispara o flush (fila não-vazia + online).
    renderHook(() => useOfflineFlush());

    // 4. O handler processa via confirmPickItem (RPC atômica) e a fila zera.
    await waitFor(async () => expect(await getOfflineQueueDepth()).toBe(0));
    expect(mockedRpc).toHaveBeenCalledWith('confirmar_item_picking', expect.objectContaining({
      p_event_id: 'evt-int-1', p_item_id: 'item-int-1', p_quantidade_separada: 6,
    }));
  });

  it('handler que falha mantém na fila SEM loop infinito (guard de re-entrância)', async () => {
    // RPC falha com erro de aplicação (não-rede) → confirmPickItem lança → handler retorna false → fica na fila.
    mockedRpc.mockResolvedValue({ error: { code: '42501', message: 'rls' } });

    registerAllOfflineHandlers();
    await enqueue('picking.confirm-item', vars);

    renderHook(() => useOfflineFlush());

    // Dá tempo do flush rodar; a fila NÃO deve zerar (operação preservada).
    await new Promise((r) => setTimeout(r, 100));
    expect(await getOfflineQueueDepth()).toBe(1);
    // Sem o guard de re-entrância, o re-emit do writeQueue re-dispararia o flush em loop
    // (centenas de chamadas). Com o guard, o handler roda só uma vez por flush.
    expect(mockedRpc.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
