import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from '@supabase/supabase-js';

vi.mock('../helpers', () => ({
  formatCustomerAddress: vi.fn().mockReturnValue('Rua X, 1'),
  resolveCustomerPhone: vi.fn().mockResolvedValue('11999999999'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), critical: vi.fn(), warn: vi.fn() },
}));

import { submitQuote } from '../submitQuote';
import type { SubmitQuoteParams, SubmitClient } from '../types';
import type { OmieCustomer, ProductCartItem } from '@/hooks/unifiedOrder/types';

interface MakeSupabaseOpts {
  obenError?: unknown;
  colacorError?: unknown;
  /** Ids de omie_products que o preflight de vendabilidade deve ver como inativos. */
  produtosInativos?: string[];
  /** Força erro na query do preflight de vendabilidade (fail-closed). */
  preflightError?: unknown;
}
function makeSupabase(opts: MakeSupabaseOpts = {}) {
  const insert = vi.fn().mockImplementation((payload: { account?: string }) =>
    Promise.resolve({ error: payload.account === 'colacor' ? (opts.colacorError ?? null) : (opts.obenError ?? null) }),
  );
  const inativosSet = new Set(opts.produtosInativos ?? []);
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'omie_products') {
      // preflight de vendabilidade: .select('id, ativo').in('id', ids). Default: ativos.
      return {
        select: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({
              data: opts.preflightError ? null : ids.map((id) => ({ id, ativo: !inativosSet.has(id) })),
              error: opts.preflightError ?? null,
            }),
        }),
      };
    }
    return { insert };
  });
  const invoke = vi.fn();
  const client = { from, functions: { invoke } } as unknown as SubmitClient;
  return { client, from, insert, invoke };
}

const customer = {
  codigo_cliente: 100,
  codigo_cliente_colacor: 200,
  codigo_vendedor: 5,
  razao_social: 'ACME LTDA',
  nome_fantasia: 'ACME',
  cnpj_cpf: '12345678000199',
} as OmieCustomer;

const user = { id: 'user-1' } as User;

function obenItem(): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 2, unit_price: 10,
    product: { id: 'p1', omie_codigo_produto: 'OBEN1', codigo: 'C1', descricao: 'Lixa', unidade: 'UN' },
  } as unknown as ProductCartItem;
}
function colacorItem(): ProductCartItem {
  return {
    type: 'product', account: 'colacor', quantity: 1, unit_price: 50,
    product: { id: 'p2', omie_codigo_produto: 'COL1', codigo: 'C2', descricao: 'Disco', unidade: 'UN' },
  } as unknown as ProductCartItem;
}

function makeParams(over: Partial<SubmitQuoteParams> & { supabase: SubmitClient }): SubmitQuoteParams {
  return {
    customer, customerUserId: 'cu-1', user,
    cart: { obenProductItems: [], colacorProductItems: [] },
    subtotals: { oben: 0, colacor: 0 },
    delivery: { option: 'balcao', selectedAddress: undefined },
    meta: { notes: '' },
    ...over,
  } as SubmitQuoteParams;
}

beforeEach(() => vi.clearAllMocks());

describe('submitQuote', () => {
  it('carrinho vazio → erro de validação, sem insert', async () => {
    const { client, insert } = makeSupabase();
    const r = await submitQuote(makeParams({ supabase: client }));
    expect(r.success).toBe(false);
    expect(r.errors[0]).toEqual({ step: 'validate', message: 'Carrinho vazio' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('produto INATIVO no carrinho → bloqueia (validate_vendabilidade), sem insert', async () => {
    const { client, insert } = makeSupabase({ produtosInativos: ['p1'] });
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [] }, // obenItem → id 'p1'
      subtotals: { oben: 20, colacor: 0 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors[0].step).toBe('validate_vendabilidade');
    expect(r.errors[0].message).toContain('C1');
    expect(insert).not.toHaveBeenCalled();
  });

  it('Oben ok → success + insert status orcamento', async () => {
    const { client, insert } = makeSupabase();
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [] },
      subtotals: { oben: 20, colacor: 0 },
    }));
    expect(r.success).toBe(true);
    expect(r.results).toContain('Orçamento Oben salvo');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ account: 'oben', status: 'orcamento' }));
  });

  it('Oben FALHA → aborta e NÃO tenta o Colacor', async () => {
    const { client, insert } = makeSupabase({ obenError: { message: 'rls' } });
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [colacorItem()] },
      subtotals: { oben: 20, colacor: 50 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => e.step === 'insert_oben_quote')).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1); // só o Oben; aborta antes do Colacor
  });

  it('Oben + Colacor ok → 2 inserts, 2 results, sem Omie', async () => {
    const { client, insert, invoke } = makeSupabase();
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [colacorItem()] },
      subtotals: { oben: 20, colacor: 50 },
    }));
    expect(r.success).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled(); // orçamento nunca sincroniza com o Omie
  });

  it('Colacor FALHA (Oben ok) → NÃO aborta: success true + erro registrado', async () => {
    const { client } = makeSupabase({ colacorError: { message: 'fk' } });
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [colacorItem()] },
      subtotals: { oben: 20, colacor: 50 },
    }));
    expect(r.success).toBe(true); // Oben salvou
    expect(r.results).toEqual(['Orçamento Oben salvo']);
    expect(r.errors.some((e) => e.step === 'insert_colacor_quote')).toBe(true);
  });

  it('produto com preço 0 → bloqueia (validate_price) sem nenhum insert', async () => {
    const { client, insert } = makeSupabase();
    const zerado = { ...obenItem(), unit_price: 0 } as ProductCartItem;
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [zerado], colacorProductItems: [] },
      subtotals: { oben: 0, colacor: 0 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors[0].step).toBe('validate_price');
    expect(insert).not.toHaveBeenCalled();
  });

  it('preço inválido numa conta bloqueia o orçamento INTEIRO (não salva a outra conta válida)', async () => {
    const { client, insert } = makeSupabase();
    const zerado = { ...colacorItem(), unit_price: 0 } as ProductCartItem;
    const r = await submitQuote(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [zerado] },
      subtotals: { oben: 20, colacor: 0 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors[0].step).toBe('validate_price');
    expect(insert).not.toHaveBeenCalled();
  });
});
