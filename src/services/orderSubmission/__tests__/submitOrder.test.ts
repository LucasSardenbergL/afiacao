import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from '@supabase/supabase-js';

// ─── Mocks de módulo (isolam submitOrder da rede/print) ───
vi.mock('@/services/omieService', () => ({
  syncOrderToOmie: vi.fn().mockResolvedValue({ success: true, omie_os: { cNumOS: 'OS1' } }),
}));
vi.mock('../buildPrintData', () => ({ buildPrintData: vi.fn().mockReturnValue([]) }));
// Mantém o `missingAccountIdentities` REAL (o preflight do submit roda com lógica
// de verdade); só as funções de I/O/format são stubadas.
vi.mock('../helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers')>();
  return {
    ...actual,
    formatCustomerAddress: vi.fn().mockReturnValue('Rua X, 1'),
    resolveCustomerPhone: vi.fn().mockResolvedValue('11999999999'),
    buildToolInfo: vi.fn().mockReturnValue(''),
    getToolName: vi.fn().mockReturnValue('Tool'),
    findParcelaDesc: vi.fn().mockReturnValue(''),
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), critical: vi.fn(), warn: vi.fn() },
}));

import { submitOrder } from '../submitOrder';
import { syncOrderToOmie } from '@/services/omieService';
import type { SubmitOrderParams, SubmitClient } from '../types';
import type { OmieCustomer, ProductCartItem, ServiceCartItem } from '@/hooks/unifiedOrder/types';

// ─── Mock supabase (injetado via params) ───
interface MakeSupabaseOpts {
  insertError?: unknown;
  insertId?: string;
  invokeImpl?: (body: { action?: string }) => { data?: unknown; error?: unknown };
  /** Ids de omie_products que o preflight de vendabilidade deve ver como inativos. */
  produtosInativos?: string[];
  /** Força erro na query do preflight de vendabilidade (fail-closed). */
  preflightError?: unknown;
}
function makeSupabase(opts: MakeSupabaseOpts = {}) {
  // ── caminho do INSERT: .from('sales_orders').insert().select('id').single() ──
  const single = vi.fn().mockResolvedValue({
    data: opts.insertError ? null : { id: opts.insertId ?? 'so-1' },
    error: opts.insertError ?? null,
  });
  const insertSelect = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockReturnValue({ select: insertSelect });
  // ── caminho do LOOKUP idempotente: .from('sales_orders')
  //    .select('id, omie_pedido_id').eq('checkout_id', …).eq('account', …).maybeSingle()
  //    Fase 0 (sem linha prévia) → sempre null → ensureSalesOrderRow vai pro INSERT. ──
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const eqAccount = vi.fn().mockReturnValue({ maybeSingle });
  const eqCheckout = vi.fn().mockReturnValue({ eq: eqAccount });
  const lookupSelect = vi.fn().mockReturnValue({ eq: eqCheckout });
  // .select() é polimórfico: com args (lookup) usa a cadeia .eq().eq().maybeSingle();
  // após .insert() (sem args, ou só 'id') usa .single(). Diferenciamos pelo callsite:
  // o lookup chama from().select(...) direto; o insert chama from().insert().select().single().
  // ── caminho do PREFLIGHT de vendabilidade: .from('omie_products')
  //    .select('id, ativo').in('id', ids). Default: todos os ids do carrinho ATIVOS
  //    (preflight passa) — só `produtosInativos` marca inativo. ──
  const inativosSet = new Set(opts.produtosInativos ?? []);
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'omie_products') {
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
    return { insert, select: lookupSelect };
  });
  const invoke = vi.fn().mockImplementation(async (_name: string, arg: { body: { action?: string } }) =>
    opts.invokeImpl ? opts.invokeImpl(arg.body) : { data: { omie_numero_pedido: '999' }, error: null },
  );
  const client = { from, functions: { invoke } } as unknown as SubmitClient;
  return { client, from, insert, invoke };
}

const customer = {
  codigo_cliente: 100,
  codigo_cliente_colacor: 200,
  codigo_vendedor: 5,
  codigo_vendedor_colacor: 6,
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
function colacorAcabado(): ProductCartItem {
  return {
    type: 'product', account: 'colacor', quantity: 1, unit_price: 50,
    product: { id: 'p2', omie_codigo_produto: 'COL1', codigo: 'C2', descricao: 'Disco acabado', unidade: 'UN', metadata: { tipo_produto: '04' } },
  } as unknown as ProductCartItem;
}
// Produto acabado sinalizado pela COLUNA dedicada (não metadata) — caminho novo pós-Migration 2026-06-04.
function colacorAcabadoColuna(): ProductCartItem {
  return {
    type: 'product', account: 'colacor', quantity: 1, unit_price: 50,
    product: { id: 'p3', omie_codigo_produto: 'COL2', codigo: 'C3', descricao: 'Disco acabado coluna', unidade: 'UN', tipo_produto: '04' },
  } as unknown as ProductCartItem;
}
function serviceItem(): ServiceCartItem {
  return {
    type: 'service', quantity: 1, notes: '', photos: [],
    servico: { descricao: 'Afiação padrão', omie_codigo_servico: 'SVC1' },
    userTool: { id: 't1', tool_category_id: 'tc1', specifications: {} },
  } as unknown as ServiceCartItem;
}
// Cliente sintético do autoatendimento (isCustomerMode): codigo_cliente=0, SEM código por-conta.
const customerSintetico = {
  codigo_cliente: 0,
  codigo_vendedor: null,
  razao_social: 'Cliente Final',
  nome_fantasia: '',
  cnpj_cpf: '11122233344',
} as OmieCustomer;

function makeParams(over: Partial<SubmitOrderParams> & { supabase: SubmitClient }): SubmitOrderParams {
  return {
    customer, customerUserId: 'cu-1', user,
    cart: { obenProductItems: [], colacorProductItems: [], serviceItems: [] },
    subtotals: { oben: 0, colacor: 0, service: 0 },
    volumes: { oben: 0, colacor: 0 },
    payment: { parcelaOben: '1', parcelaColacor: '1', afiacaoMethod: 'pix', formasPagamentoOben: [], formasPagamentoColacor: [] },
    delivery: { option: 'balcao', selectedAddress: undefined },
    meta: { notes: '', readyByDate: '', ordemCompra: '' },
    companyProfiles: {},
    defaultProductionAssigneeId: null,
    getServicePrice: () => 0,
    checkoutId: 'test-checkout',
    origem: null,
    atendimentoId: null,
    ...over,
  } as SubmitOrderParams;
}

beforeEach(() => vi.clearAllMocks());

describe('submitOrder', () => {
  it('carrinho vazio → erro de validação, sem insert', async () => {
    const { client, insert } = makeSupabase();
    const r = await submitOrder(makeParams({ supabase: client }));
    expect(r.success).toBe(false);
    expect(r.errors[0]).toEqual({ step: 'validate', message: 'Carrinho vazio' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('Oben+Colacor com itens mas SEM código Colacor → fail-closed: bloqueia TUDO antes de qualquer insert', async () => {
    const { client, insert, invoke } = makeSupabase();
    const custSemColacor = { ...customer, codigo_cliente_colacor: null } as OmieCustomer;
    const r = await submitOrder(makeParams({
      supabase: client,
      customer: custSemColacor,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [colacorAcabado()], serviceItems: [] },
      subtotals: { oben: 20, colacor: 50, service: 0 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors[0].step).toBe('validate_identity');
    expect(r.errors[0].message).toContain('Colacor');
    // Invariante: não insere NADA (nem o Oben válido) nem chama o Omie — não enviar pela metade.
    expect(insert).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('produto INATIVO no carrinho → bloqueia (validate_vendabilidade) antes de qualquer insert/Omie', async () => {
    const { client, insert, invoke } = makeSupabase({ produtosInativos: ['p1'] });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [], serviceItems: [] }, // obenItem → id 'p1'
      subtotals: { oben: 20, colacor: 0, service: 0 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors[0].step).toBe('validate_vendabilidade');
    expect(r.errors[0].message).toContain('C1'); // código do obenItem aparece na mensagem
    // Invariante money-path: não registra NADA local nem cria PV no ERP.
    expect(insert).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Oben: insert ok + Omie ok → success + PV no results', async () => {
    const { client, insert, invoke } = makeSupabase({ insertId: 'so-oben' });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [], serviceItems: [] },
      subtotals: { oben: 20, colacor: 0, service: 0 },
    }));
    expect(r.success).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ account: 'oben', status: 'rascunho' }));
    expect(invoke).toHaveBeenCalledWith('omie-vendas-sync', expect.objectContaining({
      body: expect.objectContaining({ action: 'criar_pedido', account: 'oben' }),
    }));
    expect(r.results.some((s) => s.includes('PV Oben'))).toBe(true);
    // Sync Omie OK → confirmação total → o caller pode limpar o carrinho + resetar o checkout_id.
    expect(r.allConfirmed).toBe(true);
  });

  it('Oben: insert FALHA → aborta e NÃO chama o Omie', async () => {
    const { client, invoke } = makeSupabase({ insertError: { message: 'rls denied' } });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [], serviceItems: [] },
      subtotals: { oben: 20, colacor: 0, service: 0 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => e.step === 'insert_oben')).toBe(true);
    expect(invoke).not.toHaveBeenCalled(); // invariante: sem registro local, não cria PV no ERP
  });

  it('Oben: insert ok + Omie FALHA → não aborta, marca pendente ERP', async () => {
    const { client } = makeSupabase({
      insertId: 'so-oben',
      invokeImpl: () => ({ data: null, error: { message: 'omie timeout' } }),
    });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [obenItem()], colacorProductItems: [], serviceItems: [] },
      subtotals: { oben: 20, colacor: 0, service: 0 },
    }));
    expect(r.success).toBe(true);
    expect(r.results.some((s) => s.includes('pendente ERP'))).toBe(true);
    expect(r.errors.some((e) => e.step === 'sync_oben_omie')).toBe(true);
    // Pendente ERP → NÃO é confirmação total → o caller mantém o carrinho/checkout_id p/ retry idempotente.
    expect(r.allConfirmed).toBe(false);
  });

  it('Colacor produto acabado + responsável setado → cria ordem de produção', async () => {
    const { client, invoke } = makeSupabase({
      insertId: 'so-col',
      invokeImpl: (body) => body.action === 'criar_pedido'
        ? { data: { omie_numero_pedido: '777' }, error: null }
        : { data: { ok: true }, error: null },
    });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [], colacorProductItems: [colacorAcabado()], serviceItems: [] },
      subtotals: { oben: 0, colacor: 50, service: 0 },
      defaultProductionAssigneeId: 'assignee-1',
    }));
    expect(r.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('omie-vendas-sync', expect.objectContaining({
      body: expect.objectContaining({ action: 'criar_ordem_producao', account: 'colacor' }),
    }));
  });

  it('Colacor produto acabado pela COLUNA tipo_produto → cria ordem de produção (caminho novo)', async () => {
    const { client, invoke } = makeSupabase({
      insertId: 'so-col2',
      invokeImpl: (body) => body.action === 'criar_pedido'
        ? { data: { omie_numero_pedido: '779' }, error: null }
        : { data: { ok: true }, error: null },
    });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [], colacorProductItems: [colacorAcabadoColuna()], serviceItems: [] },
      subtotals: { oben: 0, colacor: 50, service: 0 },
      defaultProductionAssigneeId: 'assignee-1',
    }));
    expect(r.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('omie-vendas-sync', expect.objectContaining({
      body: expect.objectContaining({ action: 'criar_ordem_producao', account: 'colacor' }),
    }));
  });

  it('Colacor produto acabado SEM responsável → não cria OP, erro registrado, success ainda true', async () => {
    const { client, invoke } = makeSupabase({
      insertId: 'so-col',
      invokeImpl: (body) => ({ data: { omie_numero_pedido: '888' }, error: body.action === 'criar_ordem_producao' ? { message: 'x' } : null }),
    });
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [], colacorProductItems: [colacorAcabado()], serviceItems: [] },
      subtotals: { oben: 0, colacor: 50, service: 0 },
      defaultProductionAssigneeId: null,
    }));
    expect(r.success).toBe(true);
    expect(r.errors.some((e) => e.step === 'create_production_order')).toBe(true);
    // nunca chamou criar_ordem_producao (sem responsável)
    const opCalls = invoke.mock.calls.filter((c) => (c[1] as { body: { action?: string } }).body.action === 'criar_ordem_producao');
    expect(opCalls).toHaveLength(0);
  });

  it('Modo cliente (autoatendimento): OS de afiação NÃO é bloqueada pelo preflight (cliente sintético code 0)', async () => {
    const { client } = makeSupabase();
    const r = await submitOrder(makeParams({
      supabase: client,
      customer: customerSintetico,           // codigo_cliente=0, sem código afiação
      isCustomerMode: true,
      cart: { obenProductItems: [], colacorProductItems: [], serviceItems: [serviceItem()] },
      subtotals: { oben: 0, colacor: 0, service: 30 },
    }));
    // Não pode ser bloqueado por identidade — o edge resolve por user/documento.
    expect(r.errors.some((e) => e.step === 'validate_identity')).toBe(false);
    // Mantém o comportamento antigo: customerOmieCode cai no codigo_cliente (0), não vira undefined.
    expect(syncOrderToOmie).toHaveBeenCalled();
    const staffCtx = vi.mocked(syncOrderToOmie).mock.calls[0][4];
    expect(staffCtx).toMatchObject({ customerOmieCode: 0 });
  });

  it('Staff: OS de afiação SEM código afiação → fail-closed (não chama o Omie)', async () => {
    const { client } = makeSupabase();
    // `customer` (staff) tem oben+colacor mas NÃO tem codigo_cliente_afiacao.
    const r = await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [], colacorProductItems: [], serviceItems: [serviceItem()] },
      subtotals: { oben: 0, colacor: 0, service: 30 },
    }));
    expect(r.success).toBe(false);
    expect(r.errors[0].step).toBe('validate_identity');
    expect(r.errors[0].message).toContain('Afiação');
    expect(syncOrderToOmie).not.toHaveBeenCalled();
  });

  it('Colacor: PV usa o cliente E o vendedor POR-CONTA (200/6), nunca o Oben (100/5)', async () => {
    const { client, invoke } = makeSupabase({ insertId: 'so-col' });
    await submitOrder(makeParams({
      supabase: client,
      cart: { obenProductItems: [], colacorProductItems: [colacorAcabado()], serviceItems: [] },
      subtotals: { oben: 0, colacor: 50, service: 0 },
      defaultProductionAssigneeId: 'assignee-1',
    }));
    const colacorPedido = invoke.mock.calls.find((c) => {
      const b = (c[1] as { body: { action?: string; account?: string } }).body;
      return b.action === 'criar_pedido' && b.account === 'colacor';
    });
    expect(colacorPedido).toBeDefined();
    const body = (colacorPedido![1] as { body: { codigo_cliente?: number; codigo_vendedor?: number } }).body;
    expect(body.codigo_cliente).toBe(200);   // colacor, não 100 (oben)
    expect(body.codigo_vendedor).toBe(6);    // colacor, não 5 (oben)
  });
});
