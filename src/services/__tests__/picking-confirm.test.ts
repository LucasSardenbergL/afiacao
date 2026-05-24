import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { confirmPickItem, type ConfirmPickItemVars } from '../picking-confirm';

const mockedFrom = vi.mocked(supabase.from);

/** Monta um mock de `supabase.from` que discrimina por tabela. */
function mockSupabase(opts: {
  insertResult?: { error: unknown };
  updateResult?: { error: unknown };
}) {
  const insertFn = vi.fn().mockResolvedValue(opts.insertResult ?? { error: null });
  const eqFn = vi.fn().mockResolvedValue(opts.updateResult ?? { error: null });
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  mockedFrom.mockImplementation((table: string) => {
    if (table === 'picking_events') return { insert: insertFn } as never;
    return { update: updateFn } as never;
  });
  return { insertFn, updateFn, eqFn };
}

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

beforeEach(() => mockedFrom.mockReset());

describe('confirmPickItem', () => {
  it('confirma cheio com lote correto: evento item_confirmado + update absoluto status concluido', async () => {
    const { insertFn, updateFn, eqFn } = mockSupabase({});
    const r = await confirmPickItem(baseVars);
    expect(r).toEqual({ ok: true });
    expect(insertFn).toHaveBeenCalledWith(expect.objectContaining({
      id: 'evt-1', event_type: 'item_confirmado', picking_task_item_id: 'item-1', user_id: 'user-1',
    }));
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({
      quantidade_separada: 10, status: 'concluido', lote_separado: 'LOTE-A', separado_at: '2026-05-24T12:00:00.000Z',
    }));
    expect(eqFn).toHaveBeenCalledWith('id', 'item-1');
  });

  it('replay (PK 23505 no insert) NÃO lança e ainda roda o update', async () => {
    const { updateFn } = mockSupabase({ insertResult: { error: { code: '23505', message: 'dup' } } });
    const r = await confirmPickItem(baseVars);
    expect(r).toEqual({ ok: true });
    expect(updateFn).toHaveBeenCalled();
  });

  it('lote divergente exige tipo lote_divergente', async () => {
    const { insertFn } = mockSupabase({});
    await confirmPickItem({ ...baseVars, loteInformado: 'LOTE-B', justificativa: 'lote A esgotado' });
    expect(insertFn).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'lote_divergente' }));
  });

  it('separação parcial deriva status em_andamento', async () => {
    const { updateFn } = mockSupabase({});
    await confirmPickItem({ ...baseVars, quantidadeSeparada: 4 });
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({ quantidade_separada: 4, status: 'em_andamento' }));
  });

  it('erro não-23505 no insert propaga', async () => {
    mockSupabase({ insertResult: { error: { code: '42501', message: 'rls' } } });
    await expect(confirmPickItem(baseVars)).rejects.toMatchObject({ code: '42501' });
  });
});
