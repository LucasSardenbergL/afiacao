// O que o salvar da edição manda — P0 5–8 da revisão de 2026-11-25:
//  • recusa da edge (gêmeo avançado, etapa, PV de outro cliente) chega à tela COM o motivo;
//  • pedido sem PV: salvar só a observação não regrava subtotal/total, e o UPDATE só vale se a linha
//    ainda está sem PV/sem envio/mesmo status;
//  • produto adicionado nasce pelo último preço praticado do cliente (mesma regra do Novo Pedido).
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'ord-1' }),
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
  condicoes.length = 0;
  linhasGravadas = [{ id: 'ord-1' }];
  salesOrderRow = {
    id: 'ord-1', customer_user_id: 'cust-1', created_by: 'vend-1', items: [ITEM],
    subtotal: 20, total: 20, status: 'enviado', notes: null, account: 'oben',
    omie_pedido_id: 42, omie_numero_pedido: '1001', created_at: '2026-01-01', hash_payload: null,
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
      ['is', 'envio_omie_reivindicado_em', null],
      ['is', 'deleted_at', null],
      ['eq', 'status', 'orcamento'],
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
