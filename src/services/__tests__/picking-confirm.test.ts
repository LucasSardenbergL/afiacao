import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { confirmPickItem, type ConfirmPickItemVars } from '../picking-confirm';

const mockedRpc = vi.mocked((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc);

const baseVars: ConfirmPickItemVars = {
  eventId: 'evt-1',
  pickingTaskId: 'task-1',
  pickingTaskItemId: 'item-1',
  userId: 'user-1',
  quantidade: 10,
  quantidadeSeparada: 10,
  loteEsperado: 'LOTE-A',
  loteInformado: 'LOTE-A',
  justificativa: null,
  confirmedAt: '2026-05-24T12:00:00.000Z',
};

beforeEach(() => mockedRpc.mockReset());

describe('confirmPickItem (RPC atômica)', () => {
  it('chama confirmar_item_picking com o mapeamento correto de params e retorna {ok:true}', async () => {
    mockedRpc.mockResolvedValue({ error: null });
    const r = await confirmPickItem(baseVars);
    expect(r).toEqual({ ok: true });
    expect(mockedRpc).toHaveBeenCalledWith('confirmar_item_picking', {
      p_event_id: 'evt-1',
      p_task_id: 'task-1',
      p_item_id: 'item-1',
      p_quantidade_separada: 10,
      p_lote_informado: 'LOTE-A',
      p_justificativa: null,
      p_confirmed_at: '2026-05-24T12:00:00.000Z',
    });
  });

  it('separação parcial repassa a quantidade absoluta (derivação de status é server-side)', async () => {
    mockedRpc.mockResolvedValue({ error: null });
    await confirmPickItem({ ...baseVars, quantidadeSeparada: 4 });
    expect(mockedRpc).toHaveBeenCalledWith('confirmar_item_picking', expect.objectContaining({ p_quantidade_separada: 4 }));
  });

  it('erro da RPC propaga (caller decide rollback/enfileirar)', async () => {
    mockedRpc.mockResolvedValue({ error: { code: '42501', message: 'rls' } });
    await expect(confirmPickItem(baseVars)).rejects.toMatchObject({ code: '42501' });
  });
});
