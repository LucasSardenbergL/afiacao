import { describe, it, expect, beforeEach } from 'vitest';
import { setLensActive, isLensActive, LensReadOnlyError, createLensGuardedClient } from '@/lib/impersonation/lens-write-guard';

function makeFakeClient() {
  const calls: string[] = [];
  const queryBuilder = {
    select: () => { calls.push('select'); return Promise.resolve({ data: [], error: null }); },
    insert: () => { calls.push('insert'); return Promise.resolve({ data: null, error: null }); },
    update: () => { calls.push('update'); return Promise.resolve({ data: null, error: null }); },
    upsert: () => { calls.push('upsert'); return Promise.resolve({ data: null, error: null }); },
    delete: () => { calls.push('delete'); return Promise.resolve({ data: null, error: null }); },
  };
  const bucket = {
    upload: () => { calls.push('upload'); return Promise.resolve({ data: null, error: null }); },
    download: () => { calls.push('download'); return Promise.resolve({ data: null, error: null }); },
    remove: () => { calls.push('remove'); return Promise.resolve({ data: null, error: null }); },
  };
  const client = {
    from: (..._args: unknown[]) => queryBuilder,
    rpc: () => { calls.push('rpc'); return Promise.resolve({ data: null, error: null }); },
    storage: { from: (..._args: unknown[]) => bucket },
    calls,
  };
  return client;
}

beforeEach(() => setLensActive(false));

describe('lens-write-guard', () => {
  it('fora da lente: insert/update/upsert/delete passam', () => {
    const c = createLensGuardedClient(makeFakeClient());
    c.from('t').insert(); c.from('t').update(); c.from('t').upsert(); c.from('t').delete();
    expect(c.calls).toEqual(['insert', 'update', 'upsert', 'delete']);
  });

  it('na lente: insert/update/upsert/delete lançam LensReadOnlyError', () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    expect(() => c.from('t').insert()).toThrow(LensReadOnlyError);
    expect(() => c.from('t').update()).toThrow(LensReadOnlyError);
    expect(() => c.from('t').upsert()).toThrow(LensReadOnlyError);
    expect(() => c.from('t').delete()).toThrow(LensReadOnlyError);
    expect(c.calls).toEqual([]);
  });

  it('na lente: select e download continuam passando (leitura livre)', () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    c.from('t').select();
    c.storage.from('b').download();
    expect(c.calls).toEqual(['select', 'download']);
  });

  it('na lente: storage.upload/remove lançam', () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    expect(() => c.storage.from('b').upload()).toThrow(LensReadOnlyError);
    expect(() => c.storage.from('b').remove()).toThrow(LensReadOnlyError);
  });

  it('isLensActive reflete o estado', () => {
    expect(isLensActive()).toBe(false);
    setLensActive(true);
    expect(isLensActive()).toBe(true);
  });
});
