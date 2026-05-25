import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));

import { supabase } from '@/integrations/supabase/client';
import { softDeleteOrder } from '../soft-delete';

const mockedFrom = vi.mocked(supabase.from);
const mockedInvoke = vi.mocked(supabase.functions.invoke);

function mockUpdate(eqResult: { error: unknown }) {
  const eqFn = vi.fn().mockResolvedValue(eqResult);
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  mockedFrom.mockReturnValue({ update: updateFn } as never);
  return { updateFn, eqFn };
}

const order = { id: 'ord-1', omie_pedido_id: 42 };

beforeEach(() => {
  mockedFrom.mockReset();
  mockedInvoke.mockReset();
});

describe('softDeleteOrder', () => {
  it('sucesso: soft-delete + Omie ok → { ok: true }, sem rollback', async () => {
    const { updateFn } = mockUpdate({ error: null });
    mockedInvoke.mockResolvedValue({ data: null, error: null } as never);
    const r = await softDeleteOrder(order);
    expect(r).toEqual({ ok: true });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledTimes(1); // só o soft-delete, sem rollback
  });

  it('falha no Supabase: NÃO chama Omie', async () => {
    mockUpdate({ error: { message: 'rls' } });
    const r = await softDeleteOrder(order);
    expect(r).toEqual({ ok: false, stage: 'supabase', message: 'rls' });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('falha no Omie: rollback (deleted_at=null) + stage omie', async () => {
    const { updateFn } = mockUpdate({ error: null });
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'omie down' } } as never);
    const r = await softDeleteOrder(order);
    expect(r).toEqual({ ok: false, stage: 'omie', message: 'omie down' });
    expect(updateFn).toHaveBeenCalledTimes(2); // soft-delete + rollback
    expect(updateFn).toHaveBeenLastCalledWith({ deleted_at: null });
  });
});
