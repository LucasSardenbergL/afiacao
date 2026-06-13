import { describe, it, expect } from 'vitest';
import { decideSalesOrderAction, ensureSalesOrderRow } from '../idempotency';
import type { SubmitClient } from '../types';

describe('decideSalesOrderAction', () => {
  it('linha inexistente → insert', () => {
    expect(decideSalesOrderAction(null)).toBe('insert');
  });
  it('já tem omie_pedido_id → skip (no Omie; não reenviar)', () => {
    expect(decideSalesOrderAction({ omie_pedido_id: 12345 })).toBe('skip');
  });
  it('omie_pedido_id null → reuse (rascunho de tentativa que não chegou no Omie)', () => {
    expect(decideSalesOrderAction({ omie_pedido_id: null })).toBe('reuse');
  });
});

function makeFakeSupabase(opts: {
  existing?: { id: string; omie_pedido_id: number | null } | null;
  insertResult?: { data: { id: string } | null; error: { code?: string } | null };
}) {
  const calls = { inserted: false, updated: false };
  const fake = {
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: opts.existing ?? null, error: null }),
    insert(_r: unknown) { calls.inserted = true; return {
      select() { return this; },
      single: async () => opts.insertResult ?? { data: { id: 'NEW' }, error: null },
    }; },
    update(_f: unknown) { calls.updated = true; return { eq: async () => ({ error: null }) }; },
  };
  return { fake: fake as unknown as SubmitClient, calls };
}

const baseArgs = {
  checkoutId: 'ck-1', account: 'oben', origem: null, atendimentoId: null,
  fields: { customer_user_id: 'u1', created_by: 'u1', items: [], subtotal: 0, total: 0,
    notes: null, customer_address: null, customer_phone: null, ready_by_date: null },
};

describe('ensureSalesOrderRow', () => {
  it('não existe → insere (alreadySent=false)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: null, insertResult: { data: { id: 'X' }, error: null } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'X', alreadySent: false });
    expect(calls.inserted).toBe(true);
  });
  it('existe com omie_pedido_id → skip (alreadySent=true), não muta', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Y', omie_pedido_id: 99 } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'Y', alreadySent: true });
    expect(calls.inserted).toBe(false); expect(calls.updated).toBe(false);
  });
  it('existe sem omie_pedido_id → reusa (update, alreadySent=false)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Z', omie_pedido_id: null } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'Z', alreadySent: false });
    expect(calls.updated).toBe(true); expect(calls.inserted).toBe(false);
  });
  it('corrida: insert 23505 → re-busca e reusa', async () => {
    let n = 0;
    const fake = {
      from() { return this; }, select() { return this; }, eq() { return this; },
      maybeSingle: async () => (++n === 1 ? { data: null, error: null } : { data: { id: 'RACED', omie_pedido_id: null }, error: null }),
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'RACED', alreadySent: false });
  });
  it('corrida: insert 23505 → re-busca acha linha JÁ no Omie → skip (alreadySent=true)', async () => {
    let n = 0;
    const fake = {
      from() { return this; }, select() { return this; }, eq() { return this; },
      maybeSingle: async () => (++n === 1 ? { data: null, error: null } : { data: { id: 'RACED2', omie_pedido_id: 77 }, error: null }),
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'RACED2', alreadySent: true });
  });
  it('corrida: insert 23505 mas a linha sumiu (raced=null) → erro contextual', async () => {
    const fake = {
      from() { return this; }, select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: null, error: null }),
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    await expect(ensureSalesOrderRow(fake, baseArgs)).rejects.toThrow(/linha conflitante sumiu/);
  });
});
