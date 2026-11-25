import { describe, it, expect } from 'vitest';
import { decideSalesOrderAction, ensureSalesOrderRow, pvReconciliadoConfere, valorGravadoConfere } from '../idempotency';
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

// A busca da linha é pela RPC pedido_por_checkout (omie_response é fechada por coluna — o select
// direto dava 403). O fake devolve o que a RPC devolveria: a consulta do PV só quando
// `reconciled === true`. `.from().select()` direto PROÍBE a leitura (era o vetor do 403).
function makeFakeSupabase(opts: {
  existing?: { id: string; omie_pedido_id: number | null; omie_response?: unknown; total?: unknown } | null;
  insertResult?: { data: { id: string } | null; error: { code?: string } | null };
}) {
  const calls = { inserted: false, updated: false, leuTotal: false, rpc: [] as Array<[string, unknown]> };
  const fake = {
    from() { return this; },
    // Só o `total` é lido direto (coluna aberta) — omie_response continua pela RPC pedido_por_checkout.
    select(cols: string) {
      if (cols !== 'total') throw new Error('leitura direta de sales_orders — use a RPC pedido_por_checkout');
      calls.leuTotal = true;
      return { eq: () => ({ maybeSingle: async () => ({ data: { total: opts.existing && 'total' in opts.existing ? opts.existing.total : 0 }, error: null }) }) };
    },
    rpc: async (nome: string, args: unknown) => {
      calls.rpc.push([nome, args]);
      const e = opts.existing;
      if (!e) return { data: [], error: null };
      const r = e.omie_response as { reconciled?: unknown; consulta?: unknown } | null | undefined;
      const rec = r?.reconciled === true;
      return { data: [{ id: e.id, omie_pedido_id: e.omie_pedido_id, pv_reconciliado: rec, pv_consulta: rec ? r?.consulta ?? null : null }], error: null };
    },
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
    notes: null, customer_document: null, customer_address: null, customer_phone: null, ready_by_date: null },
};

describe('ensureSalesOrderRow', () => {
  it('não existe → insere (alreadySent=false)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: null, insertResult: { data: { id: 'X' }, error: null } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'X', alreadySent: false });
    expect(calls.inserted).toBe(true);
  });
  it('busca a linha pela RPC pedido_por_checkout com o par (checkout_id, account) — não pelo select da coluna fechada', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: null });
    await ensureSalesOrderRow(fake, baseArgs);
    expect(calls.rpc).toEqual([['pedido_por_checkout', { p_checkout_id: 'ck-1', p_account: 'oben' }]]);
  });
  it('RPC devolvendo >1 linha é dado quebrado → erro, nunca escolhe às cegas', async () => {
    const { fake } = makeFakeSupabase({ existing: null });
    (fake as unknown as { rpc: unknown }).rpc = async () => ({
      data: [{ id: 'A', omie_pedido_id: 1, pv_reconciliado: false, pv_consulta: null },
             { id: 'B', omie_pedido_id: 2, pv_reconciliado: false, pv_consulta: null }], error: null });
    await expect(ensureSalesOrderRow(fake, baseArgs)).rejects.toThrow(/devolveu 2 linhas/);
  });
  it('erro da RPC (ex.: 42501) propaga — não vira "linha inexistente"', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: null });
    (fake as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { code: '42501', message: 'PEDIDO_POR_CHECKOUT_ACESSO' } });
    await expect(ensureSalesOrderRow(fake, baseArgs)).rejects.toMatchObject({ code: '42501' });
    expect(calls.inserted).toBe(false);
  });
  it('existe com omie_pedido_id → skip (alreadySent=true), não muta', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Y', omie_pedido_id: 99 } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'Y', alreadySent: true, pvDivergente: false });
    expect(calls.inserted).toBe(false); expect(calls.updated).toBe(false);
  });
  it('existe sem omie_pedido_id → reusa (update, alreadySent=false)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Z', omie_pedido_id: null } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'Z', alreadySent: false });
    expect(calls.updated).toBe(true); expect(calls.inserted).toBe(false);
  });
  it('corrida: insert 23505 → re-busca e reusa', async () => {
    let n = 0;
    let atualizou = false;
    const fake = {
      from() { return this; },
      rpc: async () => (++n === 1 ? { data: [], error: null } : { data: [{ id: 'RACED', omie_pedido_id: null, pv_reconciliado: false, pv_consulta: null }], error: null }),
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { atualizou = true; return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'RACED', alreadySent: false });
    // o rascunho da tentativa vencedora recebe o carrinho ATUAL (mesmo caminho do reuse) — Codex P2
    expect(atualizou).toBe(true);
  });
  it('corrida: insert 23505 → re-busca acha linha JÁ no Omie → skip (alreadySent=true)', async () => {
    let n = 0;
    const fake = {
      from() { return this; },
      rpc: async () => (++n === 1 ? { data: [], error: null } : { data: [{ id: 'RACED2', omie_pedido_id: 77, pv_reconciliado: false, pv_consulta: null }], error: null }),
      // total gravado = o desta tentativa (0): a corrida não muda o valor (PR 2.4).
      select() { return { eq: () => ({ maybeSingle: async () => ({ data: { total: 0 }, error: null }) }) }; },
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'RACED2', alreadySent: true, pvDivergente: false });
  });
  it('corrida: 23505 → re-busca acha PV RECONCILIADO divergente → pvDivergente (nunca "já enviado" às cegas) — Codex P1', async () => {
    let n = 0;
    const consulta = { pedido_venda_produto: { det: [{ produto: { codigo_produto: 1, quantidade: 3 } }] } };
    const fake = {
      from() { return this; },
      rpc: async () => (++n === 1 ? { data: [], error: null } : { data: [{ id: 'RACED3', omie_pedido_id: 78, pv_reconciliado: true, pv_consulta: consulta }], error: null }),
      // total gravado = o desta tentativa (0): a corrida não muda o valor (PR 2.4).
      select() { return { eq: () => ({ maybeSingle: async () => ({ data: { total: 0 }, error: null }) }) }; },
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { throw new Error('não deve atualizar linha já no Omie'); },
    } as unknown as SubmitClient;
    const args = { ...baseArgs, fields: { ...baseArgs.fields, items: [{ omie_codigo_produto: 1, quantidade: 2 }] } };
    expect(await ensureSalesOrderRow(fake, args as never)).toEqual({ id: 'RACED3', alreadySent: true, pvDivergente: true });
  });
  it('corrida: insert 23505 mas a linha sumiu (raced=null) → erro contextual', async () => {
    const fake = {
      from() { return this; },
      rpc: async () => ({ data: [], error: null }),
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    await expect(ensureSalesOrderRow(fake, baseArgs)).rejects.toThrow(/linha conflitante sumiu/);
  });
});

describe('pvReconciliadoConfere (ATP 3.3 — reenvio de PV vinculado por duplicidade)', () => {
  const rec = (det: unknown) => ({ reconciled: true, consulta: { pedido_venda_produto: { det } } });
  const linha = (c: unknown, q: unknown) => ({ produto: { codigo_produto: c, quantidade: q } });

  it('envio normal (sem reconciled) confere', () => {
    expect(pvReconciliadoConfere({ codigo_pedido: 1 }, [{ omie_codigo_produto: 1, quantidade: 9 }])).toBe(true);
    expect(pvReconciliadoConfere(null, [])).toBe(true);
  });
  it('mesmo SKU/quantidade (somando linhas) confere', () => {
    expect(pvReconciliadoConfere(rec([linha(1, 2), linha(1, 3)]), [{ omie_codigo_produto: 1, quantidade: 5 }])).toBe(true);
  });
  it('quantidade, SKU a mais ou a menos NÃO confere', () => {
    expect(pvReconciliadoConfere(rec([linha(1, 3)]), [{ omie_codigo_produto: 1, quantidade: 2 }])).toBe(false);
    expect(pvReconciliadoConfere(rec([linha(1, 2), linha(2, 1)]), [{ omie_codigo_produto: 1, quantidade: 2 }])).toBe(false);
    expect(pvReconciliadoConfere(rec([linha(2, 2)]), [{ omie_codigo_produto: 1, quantidade: 2 }])).toBe(false);
  });
  it('PV ilegível NÃO confere (nunca afirma que bate)', () => {
    expect(pvReconciliadoConfere(rec([linha(1, '2')]), [{ omie_codigo_produto: 1, quantidade: 2 }])).toBe(false);
    expect(pvReconciliadoConfere(rec({}), [{ omie_codigo_produto: 1, quantidade: 2 }])).toBe(false);
  });
  it('ensureSalesOrderRow: linha já no Omie com PV divergente devolve pvDivergente', async () => {
    const sb = makeFakeSupabase({ existing: { id: 'X', omie_pedido_id: 9, omie_response: rec([linha(1, 3)]) } as never });
    const r = await ensureSalesOrderRow(sb.fake, {
      checkoutId: 'c', account: 'oben', origem: null, atendimentoId: null,
      fields: { customer_user_id: 'u', created_by: 'u', items: [{ omie_codigo_produto: 1, quantidade: 2 }], subtotal: 1, total: 1, notes: null, customer_document: null, customer_address: null, customer_phone: null, ready_by_date: null },
    });
    expect(r).toEqual({ id: 'X', alreadySent: true, pvDivergente: true });
  });
});

describe('valorGravadoConfere — o PV já enviado tem o valor desta tentativa? (PR 2.4)', () => {
  it('mesmo valor ao centavo → confere (3,015 gravado pelo build antigo ≈ 3,02 por linha)', () => {
    expect(valorGravadoConfere(712, 712)).toBe(true);
    expect(valorGravadoConfere('712.00', 712)).toBe(true);
  });
  it('R$ 712,49 gravado × R$ 712,00 agora → NÃO confere', () => {
    expect(valorGravadoConfere(712.49, 712)).toBe(false);
  });
  it('ausente ≠ igual: null, "" ou lixo → NÃO confere', () => {
    expect(valorGravadoConfere(null, 0)).toBe(false);
    expect(valorGravadoConfere('', 0)).toBe(false);
    expect(valorGravadoConfere('abc', 0)).toBe(false);
  });
});

describe('ensureSalesOrderRow — skip confere o VALOR gravado (PR 2.4)', () => {
  it('PV já no Omie com outro total → pvDivergente=true (nunca "já enviado" calado)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Y', omie_pedido_id: 99, total: 712.49 } });
    const r = await ensureSalesOrderRow(fake, { ...baseArgs, fields: { ...baseArgs.fields, total: 712 } });
    expect(r).toEqual({ id: 'Y', alreadySent: true, pvDivergente: true });
    expect(calls.leuTotal).toBe(true);
  });
  it('mesmo total → pvDivergente=false', async () => {
    const { fake } = makeFakeSupabase({ existing: { id: 'Y', omie_pedido_id: 99, total: 712 } });
    const r = await ensureSalesOrderRow(fake, { ...baseArgs, fields: { ...baseArgs.fields, total: 712 } });
    expect(r).toEqual({ id: 'Y', alreadySent: true, pvDivergente: false });
  });
});

