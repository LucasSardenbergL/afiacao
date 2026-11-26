// O que o salvar da edição manda — P0 5–8 da revisão de 2026-11-25:
//  • recusa da edge (gêmeo avançado, etapa, PV de outro cliente) chega à tela COM o motivo;
//  • pedido sem PV: salvar só a observação não regrava subtotal/total, e o UPDATE só vale se a linha
//    ainda está sem PV/não excluída/mesmo status (sem filtrar coluna que `authenticated` não lê);
//  • produto adicionado nasce pelo último preço praticado do cliente (mesma regra do Novo Pedido).
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const navigateSpy = vi.fn();
const rota = { id: 'ord-1' };
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: rota.id }),
  useNavigate: () => navigateSpy,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics')>()),
  track: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, rpc: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { useSalesOrderEdit } from '../useSalesOrderEdit';
import type { OmieProduct } from '../types';

const mockedFrom = vi.mocked(supabase.from);
const mockedInvoke = vi.mocked(supabase.functions.invoke);
const mockedRpc = vi.mocked(supabase.rpc) as unknown as Mock<(...args: unknown[]) => unknown>;

const ITEM = { product_id: 'p-velho', omie_codigo_produto: 1, codigo: 'C1', descricao: 'Lixa 120', unidade: 'UN', quantidade: 2, valor_unitario: 10, valor_total: 20 };
let salesOrderRow: Record<string, unknown>;

// UPDATE condicionado: update → eq(id) → is(pid) → is(envio) → is(deleted) → eq(status) → select
const condicoes: Array<[string, string, unknown]> = [];
let linhasGravadas: unknown[] = [{ id: 'ord-1' }];
const updateSpy = vi.fn();
function updateBuilder() {
  const b: Record<string, unknown> = {};
  b.eq = (c: string, v: unknown) => { condicoes.push(['eq', c, v]); return b; };
  b.is = (c: string, v: unknown) => { condicoes.push(['is', c, v]); return b; };
  b.select = () => Promise.resolve({ data: linhasGravadas, error: null });
  return b;
}

function chainFor(table: string) {
  if (table === 'sales_orders') {
    return {
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: salesOrderRow, error: null }) }) }),
      update: (payload: unknown) => { updateSpy(payload); return updateBuilder(); },
    };
  }
  if (table === 'profiles') {
    return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { name: 'Cliente X' }, error: null }) }) }) };
  }
  if (table === 'cliente_tier_preco') {
    return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
  }
  if (table === 'tier_preco_config') {
    return { select: () => Promise.resolve({ data: [], error: null }) };
  }
  // omie_products: catálogo paginado (vazio) + o mapeamento product_id → código/conta dos praticados
  const b: Record<string, unknown> = {};
  b.select = () => b; b.eq = () => b; b.or = () => b; b.order = () => b;
  b.range = () => Promise.resolve({ data: [], error: null });
  b.in = () => Promise.resolve({ data: [{ id: 'p-novo', omie_codigo_produto: 555, account: 'oben' }], error: null });
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  rota.id = 'ord-1';
  condicoes.length = 0;
  linhasGravadas = [{ id: 'ord-1' }];
  salesOrderRow = {
    id: 'ord-1', customer_user_id: 'cust-1', created_by: 'vend-1', items: [ITEM],
    subtotal: 20, total: 20, status: 'enviado', notes: null, account: 'oben',
    omie_pedido_id: 42, omie_numero_pedido: '1001', created_at: '2026-01-01', updated_at: '2026-11-26T10:00:00+00', hash_payload: null,
  };
  mockedInvoke.mockResolvedValue({ data: { formas: [] }, error: null } as never);
  mockedRpc.mockImplementation(((nome: string) => {
    if (nome === 'get_ultimos_precos_cliente') {
      return Promise.resolve({ data: [{ product_id: 'p-novo', unit_price: 87.5, ultimo_praticado_em: '2026-11-01' }], error: null });
    }
    return Promise.resolve({ data: [{ id: 'ord-1', omie_payload: null, omie_response: null }], error: null });
  }) as never);
  mockedFrom.mockImplementation((table) => chainFor(table as string) as never);
});

async function renderLoaded() {
  const hook = renderHook(() => useSalesOrderEdit());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(hook.result.current.order).toBeTruthy());
  return hook;
}

describe('recusa da edge com motivo', () => {
  it('gemeo_omie: toast com o motivo da edge, não navega, registra o sensor', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({
      data: { success: false, blocked: 'gemeo_omie', contexto: 'edicao', motivo: 'o pedido já avançou no Omie (status "faturado") — altere direto no Omie.' },
      error: null,
    } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(toast.error).toHaveBeenCalledWith(
      'Edição recusada — o Omie NÃO foi atualizado',
      expect.objectContaining({ description: expect.stringContaining('status "faturado"') }),
    );
    expect(vi.mocked(track)).toHaveBeenCalledWith('pedido.edicao_bloqueada', expect.objectContaining({ motivo: 'gemeo_omie' }));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(result.current.saving).toBe(false);
  });
});

describe('pedido sem PV (caminho local)', () => {
  beforeEach(() => {
    salesOrderRow = { ...salesOrderRow, omie_pedido_id: null, status: 'orcamento', subtotal: 20, total: 15 };
  });

  it('salvar só a observação: UPDATE sem items/subtotal/total (o líquido de R$ 15 fica)', async () => {
    const { result } = await renderLoaded();
    act(() => { result.current.setNotes('entregar pela manhã'); });
    await act(async () => { await result.current.handleSave(); });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('subtotal');
    expect(payload).not.toHaveProperty('total');
    expect(payload).not.toHaveProperty('items');
    expect(payload.notes).toBe('entregar pela manhã');
    expect(condicoes).toEqual([
      ['eq', 'id', 'ord-1'],
      ['is', 'omie_pedido_id', null],
      ['is', 'deleted_at', null],
      ['eq', 'status', 'orcamento'],
      // versão da abertura: um claim de envio depois dela muda o `updated_at` e o UPDATE não casa
      ['eq', 'updated_at', '2026-11-26T10:00:00+00'],
    ]);
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/sales'));
  });

  it('mudar itens com desconto no total: recusa sem gravar', async () => {
    const { result } = await renderLoaded();
    act(() => { result.current.updateItem(0, 'quantidade', 3); });
    await act(async () => { await result.current.handleSave(); });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('desconto ou frete no total'));
  });

  it('a linha mudou enquanto editava (0 linhas no UPDATE): avisa e não navega', async () => {
    linhasGravadas = [];
    const { result } = await renderLoaded();
    await act(async () => { await result.current.handleSave(); });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('O pedido mudou enquanto você editava'));
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe('produto adicionado na edição', () => {
  const PRODUTO = {
    id: 'p-novo', omie_codigo_produto: 555, codigo: 'X9', descricao: 'Selador', unidade: 'GL',
    valor_unitario: 100, estoque: 3, ativo: true, account: 'oben', is_tintometric: false, tint_type: null,
  } as unknown as OmieProduct;

  it('nasce pelo último preço praticado do cliente, não pela tabela', async () => {
    const { result } = await renderLoaded();
    // espera os insumos de preço (praticados+tier+mult) carregarem
    await waitFor(() => {
      act(() => { result.current.addProduct(PRODUTO); });
      expect(result.current.items).toHaveLength(2);
    });
    expect(result.current.items[1].valor_unitario).toBe(87.5);
  });

  it('legado com o vendedor no lugar do cliente: tabela pura, sem ler o histórico', async () => {
    salesOrderRow = { ...salesOrderRow, customer_user_id: 'vend-1', created_by: 'vend-1' };
    const { result } = await renderLoaded();
    await waitFor(() => {
      act(() => { result.current.addProduct(PRODUTO); });
      expect(result.current.items).toHaveLength(2);
    });
    expect(result.current.items[1].valor_unitario).toBe(100);
    expect(mockedRpc).not.toHaveBeenCalledWith('get_ultimos_precos_cliente', expect.anything());
  });
});

describe('preço do cliente — falha do mapeamento avisa', () => {
  it('RPC ok mas omie_products falha: aviso ao vendedor (não nasce calado pela tabela)', async () => {
    mockedFrom.mockImplementation(((table: string) => {
      if (table === 'omie_products') {
        const b: Record<string, unknown> = {};
        b.select = () => b; b.eq = () => b; b.or = () => b; b.order = () => b;
        b.range = () => Promise.resolve({ data: [], error: null });
        b.in = () => Promise.resolve({ data: null, error: { message: 'timeout' } });
        return b;
      }
      return chainFor(table);
    }) as never);
    await renderLoaded();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Preço do cliente não carregou por completo',
      expect.objectContaining({ description: expect.stringContaining('último preço praticado') }),
    ));
  });
});

describe('preço do cliente — corrida entre pedidos', () => {
  it('a resposta tardia do pedido A não sobrescreve o preço do pedido B aberto depois', async () => {
    let soltarA: (v: unknown) => void = () => {};
    const respostaA = new Promise((r) => { soltarA = r; });
    mockedRpc.mockImplementation(((nome: string, args?: { p_customer?: string }) => {
      if (nome === 'get_ultimos_precos_cliente') {
        if (args?.p_customer === 'cust-A') return respostaA;
        return Promise.resolve({ data: [{ product_id: 'p-novo', unit_price: 95, ultimo_praticado_em: '2026-11-01' }], error: null });
      }
      return Promise.resolve({ data: [{ id: rota.id, omie_payload: null, omie_response: null }], error: null });
    }) as never);
    salesOrderRow = { ...salesOrderRow, customer_user_id: 'cust-A' };
    const hook = renderHook(() => useSalesOrderEdit());
    await waitFor(() => expect(hook.result.current.order?.customer_user_id).toBe('cust-A'));
    // abre o pedido B na MESMA instância
    salesOrderRow = { ...salesOrderRow, id: 'ord-2', customer_user_id: 'cust-B' };
    rota.id = 'ord-2';
    hook.rerender();
    await waitFor(() => expect(hook.result.current.order?.customer_user_id).toBe('cust-B'));
    const PRODUTO = {
      id: 'p-novo', omie_codigo_produto: 555, codigo: 'X9', descricao: 'Selador', unidade: 'GL',
      valor_unitario: 100, estoque: 3, ativo: true, account: 'oben', is_tintometric: false, tint_type: null,
    } as unknown as OmieProduct;
    await waitFor(() => {
      act(() => { hook.result.current.addProduct(PRODUTO); });
      expect(hook.result.current.items.some((i) => i.omie_codigo_produto === 555)).toBe(true);
    });
    // agora chega a resposta VELHA do A (R$ 80) — não pode mudar nada
    await act(async () => {
      soltarA({ data: [{ product_id: 'p-novo', unit_price: 80, ultimo_praticado_em: '2026-11-01' }], error: null });
      await respostaA;
    });
    const novo = hook.result.current.items.find((i) => i.omie_codigo_produto === 555);
    expect(novo?.valor_unitario).toBe(95);
    // e um 2º item adicionado depois da resposta velha também nasce pelo preço de B
    act(() => { hook.result.current.removeItem(hook.result.current.items.findIndex((i) => i.omie_codigo_produto === 555)); });
    act(() => { hook.result.current.addProduct(PRODUTO); });
    expect(hook.result.current.items.find((i) => i.omie_codigo_produto === 555)?.valor_unitario).toBe(95);
  });
});

describe('preço do cliente — corrida pela leitura de profiles (Codex r3)', () => {
  it('profiles de A atrasado até B carregar: A não publica e B fica com o próprio preço', async () => {
    let soltarPerfilA: (v: unknown) => void = () => {};
    const perfilA = new Promise((r) => { soltarPerfilA = r; });
    mockedRpc.mockImplementation(((nome: string, args?: { p_customer?: string }) => {
      if (nome === 'get_ultimos_precos_cliente') {
        const preco = args?.p_customer === 'cust-A' ? 80 : 95;
        return Promise.resolve({ data: [{ product_id: 'p-novo', unit_price: preco, ultimo_praticado_em: '2026-11-01' }], error: null });
      }
      return Promise.resolve({ data: [{ id: rota.id, omie_payload: null, omie_response: null }], error: null });
    }) as never);
    mockedFrom.mockImplementation(((table: string) => {
      if (table === 'profiles') {
        const atual = rota.id;
        return { select: () => ({ eq: () => ({ single: () => (atual === 'ord-1'
          ? perfilA
          : Promise.resolve({ data: { name: 'Cliente B' }, error: null })) }) }) };
      }
      return chainFor(table);
    }) as never);
    salesOrderRow = { ...salesOrderRow, customer_user_id: 'cust-A' };
    const hook = renderHook(() => useSalesOrderEdit());
    await waitFor(() => expect(hook.result.current.order?.customer_user_id).toBe('cust-A'));
    salesOrderRow = { ...salesOrderRow, id: 'ord-2', customer_user_id: 'cust-B' };
    rota.id = 'ord-2';
    hook.rerender();
    await waitFor(() => expect(hook.result.current.customerName).toBe('Cliente B'));
    const PRODUTO = {
      id: 'p-novo', omie_codigo_produto: 555, codigo: 'X9', descricao: 'Selador', unidade: 'GL',
      valor_unitario: 100, estoque: 3, ativo: true, account: 'oben', is_tintometric: false, tint_type: null,
    } as unknown as OmieProduct;
    await waitFor(() => expect(hook.result.current.precoPrevisto(PRODUTO)).toBe(95));
    // a leitura VELHA de A chega agora
    await act(async () => { soltarPerfilA({ data: { name: 'Cliente A' }, error: null }); await perfilA; });
    await new Promise((r) => setTimeout(r, 20));
    expect(hook.result.current.customerName).toBe('Cliente B');
    expect(hook.result.current.precoPrevisto(PRODUTO)).toBe(95);
    act(() => { hook.result.current.addProduct(PRODUTO); });
    expect(hook.result.current.items.find((i) => i.omie_codigo_produto === 555)?.valor_unitario).toBe(95);
  });
});

describe('parcela no alterar_pedido (Codex r3)', () => {
  const corpoAlterar = () => {
    const chamada = mockedInvoke.mock.calls.find(([, o]) => {
      const corpo = (o as { body?: Record<string, unknown> })?.body;
      return corpo !== undefined && 'observacao' in corpo;
    });
    return (chamada?.[1] as { body: Record<string, unknown> }).body;
  };
  beforeEach(() => {
    mockedRpc.mockImplementation(((nome: string) => {
      if (nome === 'get_ultimos_precos_cliente') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{ id: 'ord-1', omie_payload: { cabecalho: { codigo_parcela: '028' } }, omie_response: null }], error: null });
    }) as never);
  });

  it('vendedor não mexeu no prazo: não envia codigo_parcela (a edge herda o prazo VIVO do PV)', async () => {
    const { result } = await renderLoaded();
    await waitFor(() => expect(result.current.selectedParcela).toBe('028'));
    act(() => { result.current.setNotes('só a observação'); });
    await act(async () => { await result.current.handleSave(); });
    expect(corpoAlterar()).toBeDefined();
    expect(corpoAlterar().codigo_parcela).toBeUndefined();
  });

  it('vendedor trocou o prazo: envia o escolhido', async () => {
    const { result } = await renderLoaded();
    await waitFor(() => expect(result.current.selectedParcela).toBe('028'));
    act(() => { result.current.setSelectedParcela('042'); });
    await act(async () => { await result.current.handleSave(); });
    expect(corpoAlterar().codigo_parcela).toBe('042');
  });
});
