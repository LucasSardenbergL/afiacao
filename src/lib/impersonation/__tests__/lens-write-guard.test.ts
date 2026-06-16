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
    update: () => { calls.push('storage_update'); return Promise.resolve({ data: null, error: null }); },
    download: () => { calls.push('download'); return Promise.resolve({ data: null, error: null }); },
    remove: () => { calls.push('remove'); return Promise.resolve({ data: null, error: null }); },
  };
  const client = {
    from: (..._args: unknown[]) => queryBuilder,
    rpc: (..._args: unknown[]) => { calls.push('rpc'); return Promise.resolve({ data: null, error: null }); },
    storage: { from: (..._args: unknown[]) => bucket },
    functions: { invoke: (..._args: unknown[]) => { calls.push('invoke'); return Promise.resolve({ data: null, error: null }); } },
    calls,
  };
  return client;
}

beforeEach(() => setLensActive(false));

describe('lens-write-guard', () => {
  it('fora da lente: insert/update/upsert/delete passam', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    await c.from('t').insert(); await c.from('t').update(); await c.from('t').upsert(); await c.from('t').delete();
    expect(c.calls).toEqual(['insert', 'update', 'upsert', 'delete']);
  });

  it('na lente: insert/update/upsert/delete REJEITAM com LensReadOnlyError (sem throw síncrono)', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    // NÃO deve lançar de forma síncrona — só ao consumir a Promise.
    expect(() => c.from('t').insert()).not.toThrow();
    await expect(c.from('t').insert()).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.from('t').update()).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.from('t').upsert()).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.from('t').delete()).rejects.toBeInstanceOf(LensReadOnlyError);
    expect(c.calls).toEqual([]); // nenhuma mutação chegou ao client real
  });

  it('na lente: encadeamento pós-mutação não crasha e rejeita no consumo (.insert().select())', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    const chain = (c.from('t').insert() as unknown as { select: () => unknown }).select();
    await expect(Promise.resolve(chain)).rejects.toBeInstanceOf(LensReadOnlyError);
    expect(c.calls).toEqual([]);
  });

  it('na lente: o handler de rejeição via .then(onOk, onErr) é chamado (não escapa do .catch)', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    let capturado: unknown = null;
    await (c.from('t').upsert() as unknown as { then: (ok: unknown, err: (e: unknown) => void) => Promise<unknown> })
      .then(() => undefined, (e: unknown) => { capturado = e; });
    expect(capturado).toBeInstanceOf(LensReadOnlyError);
  });

  it('na lente: select e download continuam passando (leitura livre)', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await c.from('t').select();
    await c.storage.from('b').download();
    expect(c.calls).toEqual(['select', 'download']);
  });

  it('na lente: storage upload/update/remove rejeitam', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await expect(c.storage.from('b').upload()).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.storage.from('b').update()).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.storage.from('b').remove()).rejects.toBeInstanceOf(LensReadOnlyError);
  });

  it('na lente: functions.invoke é bloqueado (não dispara edge function)', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await expect(c.functions.invoke('whatsapp-send')).rejects.toBeInstanceOf(LensReadOnlyError);
    expect(c.calls).toEqual([]);
  });

  it('fora da lente: functions.invoke passa', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    await c.functions.invoke('x');
    expect(c.calls).toEqual(['invoke']);
  });

  it('na lente: rpc mutante (não get_/list_) é bloqueada', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await expect(c.rpc('registrar_contato_rota')).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.rpc('confirmar_item_picking')).rejects.toBeInstanceOf(LensReadOnlyError);
    expect(c.calls).toEqual([]);
  });

  it('na lente: rpc de leitura (get_/list_) passa', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await c.rpc('get_minha_positivacao');
    await c.rpc('list_impersonation_targets');
    expect(c.calls).toEqual(['rpc', 'rpc']);
  });

  it('na lente: rpc de LEITURA com nome em português na allowlist (listar_) passa', async () => {
    // `listar_pedidos_a_separar` é leitura pura mas NÃO casa o prefixo `list_` (PT).
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await c.rpc('listar_pedidos_a_separar');
    expect(c.calls).toEqual(['rpc']);
  });

  it('na lente: rpc de ESCRITA com nome ambíguo FORA da allowlist (ciclo_/sugerir_) é bloqueada', async () => {
    // Guarda contra allowlistar às cegas: ciclo_oportunidade_do_dia e
    // sugerir_negociacao_paralela_hoje GERAM pedidos/sugestões (escrita).
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    await expect(c.rpc('ciclo_oportunidade_do_dia')).rejects.toBeInstanceOf(LensReadOnlyError);
    await expect(c.rpc('sugerir_negociacao_paralela_hoje')).rejects.toBeInstanceOf(LensReadOnlyError);
    expect(c.calls).toEqual([]);
  });

  it('fora da lente: rpc mutante passa', async () => {
    const c = createLensGuardedClient(makeFakeClient());
    await c.rpc('registrar_contato_rota');
    expect(c.calls).toEqual(['rpc']);
  });

  it('isLensActive reflete o estado', () => {
    expect(isLensActive()).toBe(false);
    setLensActive(true);
    expect(isLensActive()).toBe(true);
  });
});
