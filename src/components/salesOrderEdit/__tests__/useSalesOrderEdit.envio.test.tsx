// O que o salvar da edição manda — P0 5–8 da revisão de 2026-11-25:
//  • recusa da edge (gêmeo avançado, etapa, PV de outro cliente) chega à tela COM o motivo;
//  • pedido sem PV: salvar só a observação não regrava subtotal/total, e o UPDATE só vale se a linha
//    ainda está sem PV/não excluída/mesmo status (sem filtrar coluna que `authenticated` não lê);
//  • produto adicionado nasce pelo último preço praticado do cliente (mesma regra do Novo Pedido).
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const navigateSpy = vi.fn();
const rota = { id: 'ord-1' };
// Posse durável (migration 20261127100200): as 3 RPCs da posse respondem por `posseMock` (padrão: PV livre);
// o resto vai ao mock de sempre (`mockedRpc`). Sem isto o estado viria "ilegível" e a tela travaria (fail-closed).
const { rpcInterno, posseMock, rpcComPosse } = vi.hoisted(() => {
  const rpcInterno = vi.fn();
  const posseMock = {
    estado: { data: { situacao: 'livre' }, error: null } as unknown,
    encerrar: { data: 'divergente', error: null } as unknown,
    resolver: { data: 'resolvida', error: null } as unknown,
    chamadas: [] as Array<{ nome: string; args: unknown }>,
    // Banco COERENTE: o pedido cujo encerramento respondeu `divergente` passa a ler divergente na abertura.
    divergentesNoBanco: new Set<string>(),
  };
  const RESPOSTA: Record<string, keyof typeof posseMock> = {
    pedido_edicao_omie_estado: 'estado',
    pedido_edicao_omie_encerrar_envio: 'encerrar',
    pedido_edicao_omie_resolver: 'resolver',
  };
  const rpcComPosse = (nome: string, args?: unknown) => {
    const chave = RESPOSTA[nome];
    if (!chave) return rpcInterno(nome, args);
    posseMock.chamadas.push({ nome, args });
    const pedido = (args as { p_sales_order_id?: string } | undefined)?.p_sales_order_id ?? '';
    if (chave === 'estado' && posseMock.divergentesNoBanco.has(pedido)) {
      return Promise.resolve({ data: { situacao: 'divergente', token: 'tok-banco', motivo: null }, error: null });
    }
    // Lista = respostas em sequência (a última se repete): é como o teste encena "em voo, depois concluída".
    const v = posseMock[chave];
    const resposta = Array.isArray(v) ? (v.length > 1 ? v.shift() : v[0]) : v;
    if (chave === 'encerrar' && (resposta as { data?: unknown })?.data === 'divergente') posseMock.divergentesNoBanco.add(pedido);
    return Promise.resolve(resposta);
  };
  return { rpcInterno, posseMock, rpcComPosse };
});
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: rota.id }),
  useNavigate: () => navigateSpy,
}));
const authMock = vi.hoisted(() => ({ isMaster: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics')>()),
  track: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, rpc: rpcComPosse },
}));

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { useSalesOrderEdit } from '../useSalesOrderEdit';
import { comQueryClient } from '@/test/query-client';
import { limparRegistroParaTeste } from '../registroEnvios';
import { QueryClient } from '@tanstack/react-query';
import type { OmieProduct } from '../types';

const mockedFrom = vi.mocked(supabase.from);
const mockedInvoke = vi.mocked(supabase.functions.invoke);
const mockedRpc = rpcInterno as unknown as Mock<(...args: unknown[]) => unknown>;

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
  posseMock.estado = { data: { situacao: 'livre' }, error: null };
  posseMock.encerrar = { data: 'divergente', error: null };
  posseMock.resolver = { data: 'resolvida', error: null };
  posseMock.chamadas = [];
  posseMock.divergentesNoBanco.clear();
  authMock.isMaster = false;
  vi.clearAllMocks();
  limparRegistroParaTeste();
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
  const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient() });
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

  it('caminho local também invalida o cache do pedido (#16)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient(client) });
    await waitFor(() => expect(hook.result.current.order).toBeTruthy());
    act(() => { hook.result.current.setNotes('nova'); });
    await act(async () => { await hook.result.current.handleSave(); });
    await waitFor(() => expect(spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey))).toContain('["order-detail"]'));
  });

  it('caminho local não usa o registro de envio (reabrir lê normalmente) — a trava de versão protege', async () => {
    const { estadoDoPedido } = await import('../registroEnvios');
    const { result } = await renderLoaded();
    let confirmar: (v: unknown) => void = () => {};
    const pendurado = updateBuilder();
    pendurado.select = () => new Promise((r) => { confirmar = r; });
    mockedFrom.mockImplementation(((t: string) => t === 'sales_orders'
      ? { ...chainFor(t), update: (payload: unknown) => { updateSpy(payload); return pendurado; } }
      : chainFor(t)) as never);
    act(() => { result.current.setNotes('nova'); });
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = result.current.handleSave(); });
    expect(estadoDoPedido('ord-1').emVoo).toBe(false);
    expect(condicoes).toContainEqual(['eq', 'updated_at', '2026-11-26T10:00:00+00']);
    await act(async () => { confirmar({ data: [{ id: 'ord-1' }], error: null }); await envio; });
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
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient() });
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
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient() });
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
      return corpo?.action === 'alterar_pedido';
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

// ── Revisão /sales, leva 1 (#4 #7 #10 #15 #16 #30 #48) ─────────────────────────────────────────────────

/** Erro do `functions.invoke` como o supabase-js entrega: o corpo do 500 fica em `context`. */
function erroDaEdge(corpo: Record<string, unknown>) {
  return { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(corpo), { status: 500 }) };
}

function bodyDoAlterar() {
  const chamada = mockedInvoke.mock.calls.find(([, o]) => (o as { body?: { action?: string } })?.body?.action === 'alterar_pedido');
  return (chamada?.[1] as { body: Record<string, unknown> } | undefined)?.body;
}

describe('leva 1 — versão e falha que exige recarregar (#7, #30)', () => {
  it('envia a versão (updated_at) que a tela viu', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(bodyDoAlterar()?.versao).toBe('2026-11-26T10:00:00+00');
  });

  it('blocked edicao_concorrente: trava o formulário e não deixa reenviar o mesmo retrato', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: false, blocked: 'edicao_concorrente', motivo: 'mudou' }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar).not.toBeNull();
    expect(result.current.formularioTravado).toBe(true);
    expect(navigateSpy).not.toHaveBeenCalled();
    mockedInvoke.mockClear();
    await act(async () => { await result.current.handleSave(); });
    expect(bodyDoAlterar()).toBeUndefined(); // o 2º clique não chega à edge
  });

  it('edicao_concorrente: recarregar destrava (nada nosso mexeu no Omie)', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: false, blocked: 'edicao_concorrente', motivo: 'mudou' }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('concorrente');
    mockedInvoke.mockResolvedValue({ data: { formas: [] }, error: null } as never);
    await act(async () => { await result.current.recarregar(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.precisaRecarregar).toBeNull();
    expect(result.current.formularioTravado).toBe(false);
  });

  it('500 com precisa_recarregar: divergente — recarregar NÃO destrava (relê o app, não o Omie)', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: erroDaEdge({ error: 'Omie ATUALIZADO mas o registro local falhou', precisa_recarregar: true }) } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    mockedInvoke.mockResolvedValue({ data: { formas: [] }, error: null } as never);
    await act(async () => { await result.current.recarregar(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    expect(result.current.formularioTravado).toBe(true);
    mockedInvoke.mockClear();
    await act(async () => { await result.current.handleSave(); });
    expect(bodyDoAlterar()).toBeUndefined();
  });

  it('edge anterior (500 sem a chave): desfecho desconhecido congela', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: erroDaEdge({ error: 'Omie não confirmou a substituição completa dos itens do pedido' }) } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
  });

  it('resposta perdida (sem corpo): congela', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Failed to send a request to the Edge Function' } } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
  });

  it('falha ANTES da reserva (precisa_recarregar: false): não trava — tentar de novo é seguro', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: erroDaEdge({ error: 'Edição não aplicada: nada foi alterado — tente novamente.', precisa_recarregar: false }) } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar).toBeNull();
    expect(result.current.formularioTravado).toBe(false);
  });
});

describe('leva 1 — cache depois de salvar (#16)', () => {
  it('sucesso invalida lista, soma, detalhe e descontos', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient(client) });
    await waitFor(() => expect(hook.result.current.order).toBeTruthy());
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);
    await act(async () => { await hook.result.current.handleSave(); });
    const chaves = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    for (const k of ['["order-feed"]', '["order-feed-total"]', '["order-detail"]', '["order-descontos-itens"]']) {
      expect(chaves).toContain(k);
    }
    expect(navigateSpy).toHaveBeenCalledWith('/sales');
  });

  it('recusa da edge também invalida (desfecho pós-despacho) mas não navega', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient(client) });
    await waitFor(() => expect(hook.result.current.order).toBeTruthy());
    mockedInvoke.mockResolvedValue({ data: { success: false, blocked: 'gemeo_omie', motivo: 'x' }, error: null } as never);
    await act(async () => { await hook.result.current.handleSave(); });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe('leva 1 — formulário congelado durante o envio (#48)', () => {
  it('editar item enquanto o envio voa é ignorado; 2º clique não dispara 2ª chamada', async () => {
    const { result } = await renderLoaded();
    let soltar: (v: unknown) => void = () => {};
    mockedInvoke.mockImplementation((() => new Promise((r) => { soltar = r; })) as never);
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = result.current.handleSave(); });
    await waitFor(() => expect(result.current.saving).toBe(true));
    expect(result.current.formularioTravado).toBe(true);
    act(() => { result.current.updateItem(0, 'quantidade', 99); });
    act(() => { void result.current.handleSave(); });
    expect(result.current.items[0].quantidade).toBe(2);
    expect(mockedInvoke.mock.calls.filter(([, o]) => (o as { body?: { action?: string } })?.body?.action === 'alterar_pedido')).toHaveLength(1);
    await act(async () => { soltar({ data: { success: false, blocked: 'gemeo_omie', motivo: 'x' }, error: null }); await envio; });
    expect(result.current.saving).toBe(false);
    expect(result.current.formularioTravado).toBe(false);
  });

  it('temAlteracaoPendente: falso ao abrir, verdadeiro ao mexer na observação', async () => {
    const { result } = await renderLoaded();
    expect(result.current.temAlteracaoPendente).toBe(false);
    act(() => { result.current.setNotes('nova'); });
    expect(result.current.temAlteracaoPendente).toBe(true);
  });
});

describe('leva 1 — troca de pedido na mesma rota (#15)', () => {
  it('B sem parcela não herda a parcela de A', async () => {
    mockedRpc.mockImplementation(((nome: string, args: { p_order_ids?: string[] }) => {
      if (nome === 'staff_get_sales_order_payload') {
        const id = args?.p_order_ids?.[0];
        return Promise.resolve({ data: [{ id, omie_payload: id === 'ord-1' ? { cabecalho: { codigo_parcela: 'A01' } } : null }], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    }) as never);
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient() });
    await waitFor(() => expect(hook.result.current.selectedParcela).toBe('A01'));
    rota.id = 'ord-2';
    salesOrderRow = { ...salesOrderRow, id: 'ord-2' };
    hook.rerender();
    await waitFor(() => expect(hook.result.current.order?.id).toBe('ord-2'));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.selectedParcela).toBe('');
  });
});

describe('leva 1 — conta do pedido (#4)', () => {
  it('conta fora de oben|colacor: abre travado e não carrega catálogo/condições de outra empresa', async () => {
    salesOrderRow = { ...salesOrderRow, account: 'colacor_sc' };
    const { result } = await renderLoaded();
    expect(result.current.isBlocked).toBe(true);
    expect(result.current.motivoBloqueio).toContain('colacor_sc');
    expect(mockedInvoke.mock.calls.some(([, o]) => (o as { body?: { action?: string } })?.body?.action === 'listar_formas_pagamento')).toBe(false);
    await act(async () => { await result.current.handleSave(); });
    expect(bodyDoAlterar()).toBeUndefined();
  });
});

describe('leva 1 — base alternativa de tinta (#10)', () => {
  it('base alternativa fora do catálogo: recusa em vez de gravar o SKU da base original', async () => {
    const { result } = await renderLoaded();
    const base = { id: 'base-1', omie_codigo_produto: 10, codigo: 'B1', descricao: 'Base A', unidade: 'GL', valor_unitario: 100, estoque: 5, ativo: true, account: 'oben', is_tintometric: true, tint_type: 'base' } as OmieProduct;
    act(() => { result.current.setTintPendingProduct(base); });
    const antes = result.current.items.length;
    act(() => {
      result.current.handleTintConfirm('f1', 'COR1', 'Azul', 150, 0, undefined, { id: 'base-alt-fora', codigo: 'B2', descricao: 'Base B' } as never);
    });
    expect(result.current.items).toHaveLength(antes);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('não está no catálogo'), expect.anything());
  });
});

describe('leva 1 — Codex no diff (2026-11-26)', () => {
  it.each([
    ['HTML de proxy', '<html>502</html>'],
    ['success como texto', { success: 'false' }],
    ['corpo vazio', {}],
    ['blocked desconhecido', { success: false, blocked: 'algo_novo' }],
  ])('200 ambíguo (%s): divergente, sem sucesso falso nem navegação', async (_nome, data) => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    const envios = mockedInvoke.mock.calls.filter(([, o]) => (o as { body?: { action?: string } })?.body?.action === 'alterar_pedido');
    expect(envios).toHaveLength(1); // ESTE caso despachou — não herdou trava do anterior
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith('Pedido atualizado e sincronizado com o Omie!');
  });

  it('sem resposta no prazo: divergente e o envio é liberado (a tela não fica presa)', async () => {
    const { PRAZOS } = await import('../envioEdicao');
    const original = PRAZOS.envioMs;
    PRAZOS.envioMs = 30;
    try {
      const { result } = await renderLoaded();
      mockedInvoke.mockImplementation((async (_n: string, o: { body?: { action?: string } }) =>
        o?.body?.action === 'alterar_pedido' ? new Promise(() => {}) : { data: { formas: [] }, error: null }) as never);
      await act(async () => { await result.current.handleSave(); });
      expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
      expect(result.current.saving).toBe(false);
      const { estadoDoPedido } = await import('../registroEnvios');
      expect(estadoDoPedido('ord-1').emVoo).toBe(false);
    } finally {
      PRAZOS.envioMs = original;
    }
  });

  it('corpo do 500 lido UMA vez (mensagem e precisa_recarregar da mesma leitura)', async () => {
    const { result } = await renderLoaded();
    let leituras = 0;
    const ctx = { status: 500, clone: () => ({ json: async () => { leituras++; return { error: 'Edição recusada: x', precisa_recarregar: false }; } }) };
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'sdk', context: ctx } } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(leituras).toBe(1);
    expect(result.current.precisaRecarregar).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Edição recusada: x'), expect.anything());
  });

  // A página remonta o editor a cada :id (SalesOrderEdit.tsx, key={id}): trocar de pedido = desmontar A e
  // montar B. Os testes abaixo fazem exatamente isso.
  async function abrir(id: string) {
    rota.id = id;
    salesOrderRow = { ...salesOrderRow, id };
    return renderLoaded();
  }
  function abrirSemEsperar(id: string) {
    rota.id = id;
    salesOrderRow = { ...salesOrderRow, id };
    return renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient() });
  }
  function envioPendurado() {
    let soltar: (v: unknown) => void = () => {};
    mockedInvoke.mockImplementation((async (_n: string, o: { body?: { action?: string } }) =>
      o?.body?.action === 'alterar_pedido' ? new Promise((r) => { soltar = r; }) : { data: { formas: [] }, error: null }) as never);
    return (v: unknown) => soltar(v);
  }

  it('resposta atrasada do salvar de A não publica nada na tela de B; reabrir A volta travado', async () => {
    const a = await abrir('ord-1');
    const soltar = envioPendurado();
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = a.result.current.handleSave(); });
    a.unmount();
    const b = await abrir('ord-2');
    vi.mocked(toast.error).mockClear();
    await act(async () => { soltar({ data: null, error: erroDaEdge({ error: 'x', precisa_recarregar: true }) }); await envio; });
    expect(b.result.current.precisaRecarregar).toBeNull();
    expect(b.result.current.saving).toBe(false);
    expect(b.result.current.formularioTravado).toBe(false);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled(); // o erro de A não aparece como se fosse de B
    b.unmount();
    const a2 = await abrir('ord-1');
    expect(a2.result.current.precisaRecarregar?.tipo).toBe('divergente');
  });

  it('A → B → A antes da resposta: a nova tela de A congela e trava quando a divergência chega', async () => {
    const a = await abrir('ord-1');
    const soltar = envioPendurado();
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = a.result.current.handleSave(); });
    a.unmount();
    (await abrir('ord-2')).unmount();
    const a2 = abrirSemEsperar('ord-1');
    expect(a2.result.current.envioDeOutraTela).toBe(true);
    expect(a2.result.current.formularioTravado).toBe(true);
    await act(async () => { soltar({ data: { success: 'false' }, error: null }); await envio; });
    await waitFor(() => expect(a2.result.current.order?.id).toBe('ord-1'));
    expect(a2.result.current.envioDeOutraTela).toBe(false);
    expect(a2.result.current.precisaRecarregar?.tipo).toBe('divergente');
  });

  it('A → B → A com o envio voando: o 2º salvar é recusado (um envio por pedido)', async () => {
    const a = await abrir('ord-1');
    const soltar = envioPendurado();
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = a.result.current.handleSave(); });
    a.unmount();
    const a2 = abrirSemEsperar('ord-1');
    await act(async () => { await a2.result.current.handleSave(); });
    const envios = mockedInvoke.mock.calls.filter(([, o]) => (o as { body?: { action?: string } })?.body?.action === 'alterar_pedido');
    expect(envios).toHaveLength(1);
    await act(async () => { soltar({ data: { success: true }, error: null }); await envio; });
  });

  it('quando o envio da outra tela termina com sucesso, a tela que esperava RELÊ o pedido antes de liberar', async () => {
    const a = await abrir('ord-1');
    const soltar = envioPendurado();
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = a.result.current.handleSave(); });
    a.unmount();
    const a2 = abrirSemEsperar('ord-1');
    // Enquanto o envio de A voa, a tela nova NÃO lê o pedido (leria o carrinho de antes): fica carregando.
    await new Promise((r) => setTimeout(r, 20));
    expect(a2.result.current.loading).toBe(true);
    expect(a2.result.current.order).toBeNull();
    salesOrderRow = { ...salesOrderRow, items: [{ ...ITEM, quantidade: 3, valor_total: 30 }], updated_at: '2026-11-26T11:00:00+00' };
    await act(async () => { soltar({ data: { success: true }, error: null }); await envio; });
    await waitFor(() => expect(a2.result.current.items[0].quantidade).toBe(3));
    expect(a2.result.current.order?.updated_at).toBe('2026-11-26T11:00:00+00');
    expect(a2.result.current.formularioTravado).toBe(false);
  });

  it('401/403 (gate de autenticação, antes da ação): não é divergência', async () => {
    for (const status of [401, 403]) {
      const { result, unmount } = await renderLoaded();
      mockedInvoke.mockResolvedValue({ data: null, error: { message: 'x', context: new Response(JSON.stringify({ error: 'Unauthorized' }), { status }) } } as never);
      await act(async () => { await result.current.handleSave(); });
      expect(result.current.precisaRecarregar).toBeNull();
      unmount();
    }
  });

  it('preço de A que falha depois de abrir B não avisa na tela de B', async () => {
    let falhar: (e: unknown) => void = () => {};
    mockedRpc.mockImplementation(((nome: string) => {
      if (nome === 'get_ultimos_precos_cliente') return new Promise((_r, rej) => { falhar = rej; });
      return Promise.resolve({ data: [{ id: rota.id, omie_payload: null, omie_response: null }], error: null });
    }) as never);
    const a = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient() });
    await waitFor(() => expect(a.result.current.order).toBeTruthy());
    const falharA = falhar;
    a.unmount();
    mockedRpc.mockImplementation(((nome: string) => nome === 'get_ultimos_precos_cliente'
      ? Promise.resolve({ data: [], error: null })
      : Promise.resolve({ data: [{ id: 'ord-2', omie_payload: null, omie_response: null }], error: null })) as never);
    await abrir('ord-2');
    vi.mocked(toast.warning).mockClear();
    await act(async () => { falharA(new Error('rede')); await new Promise((r) => setTimeout(r, 0)); });
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
  });

  it('sucesso de A com B aberto: B não navega', async () => {
    const a = await abrir('ord-1');
    const soltar = envioPendurado();
    let envio: Promise<void> = Promise.resolve();
    act(() => { envio = a.result.current.handleSave(); });
    a.unmount();
    await abrir('ord-2');
    navigateSpy.mockClear();
    await act(async () => { soltar({ data: { success: true }, error: null }); await envio; });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('observação vai SEMPRE, igual à do app (ERP e cupom com a mesma nota)', async () => {
    salesOrderRow = { ...salesOrderRow, notes: 'sinal de R$ 500' };
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);
    act(() => { result.current.updateItem(0, 'quantidade', 3); });
    await act(async () => { await result.current.handleSave(); });
    expect(bodyDoAlterar()?.observacao).toBe('sinal de R$ 500');
  });

  it('cancela as leituras em voo ANTES de invalidar (pré-carga antiga não repõe o valor velho)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ordem: string[] = [];
    vi.spyOn(client, 'cancelQueries').mockImplementation((async () => { ordem.push('cancel'); }) as never);
    vi.spyOn(client, 'invalidateQueries').mockImplementation((async () => { ordem.push('invalidate'); }) as never);
    const hook = renderHook(() => useSalesOrderEdit(), { wrapper: comQueryClient(client) });
    await waitFor(() => expect(hook.result.current.order).toBeTruthy());
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);
    await act(async () => { await hook.result.current.handleSave(); });
    expect(ordem.indexOf('invalidate')).toBeGreaterThan(ordem.lastIndexOf('cancel'));
    expect(ordem.filter((x) => x === 'cancel')).toHaveLength(4);
  });

  it('#10: recusa da base alternativa devolve "conflito" (o diálogo não conta cor confirmada)', async () => {
    const { result } = await renderLoaded();
    const base = { id: 'base-1', omie_codigo_produto: 10, codigo: 'B1', descricao: 'Base A', unidade: 'GL', valor_unitario: 100, estoque: 5, ativo: true, account: 'oben', is_tintometric: true, tint_type: 'base' } as OmieProduct;
    act(() => { result.current.setTintPendingProduct(base); });
    let r: unknown;
    act(() => { r = result.current.handleTintConfirm('f1', 'COR1', 'Azul', 150, 0, undefined, { id: 'fora' } as never); });
    expect(r).toBe('conflito');
  });
});

describe('leva 1 PR 2 — posse durável no banco (migration 20261127100200)', () => {
  let reconsultaOriginal = 0;
  beforeEach(async () => {
    const { PRAZOS } = await import('../envioEdicao');
    reconsultaOriginal = PRAZOS.reconsultaMs;
    PRAZOS.reconsultaMs = 1;
    return () => { PRAZOS.reconsultaMs = reconsultaOriginal; };
  });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const encerramentos = () => posseMock.chamadas.filter((c) => c.nome === 'pedido_edicao_omie_encerrar_envio');

  it('o salvamento manda um token próprio (UUID) — é por ele que a tela pergunta ao banco', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(String(bodyDoAlterar()?.token)).toMatch(UUID);
    expect(encerramentos()).toHaveLength(0); // sucesso provado não consulta nem encerra nada
  });

  it('resposta perdida + banco diz abandonada: trava CONCORRENTE (recarregar é seguro), pelo MESMO token', async () => {
    posseMock.encerrar = { data: 'abandonada', error: null };
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Failed to send a request to the Edge Function' } } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('concorrente');
    expect(encerramentos()).toHaveLength(1);
    expect(encerramentos()[0].args).toEqual({ p_sales_order_id: 'ord-1', p_token: bodyDoAlterar()?.token });
    const { estadoDoPedido } = await import('../registroEnvios');
    expect(estadoDoPedido('ord-1').divergente).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ description: expect.stringContaining('não alterou o Omie') }));
  });

  it('500 pós-despacho + banco diz concluida: sucesso CONFIRMADO pelo banco, navega', async () => {
    posseMock.encerrar = { data: 'concluida', error: null };
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: erroDaEdge({ error: 'timeout do write-back', precisa_recarregar: true }) } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(toast.success).toHaveBeenCalledWith('Pedido atualizado e sincronizado com o Omie!', expect.objectContaining({ description: expect.stringContaining('banco confirmou') }));
    expect(navigateSpy).toHaveBeenCalledWith('/sales');
    expect(result.current.precisaRecarregar).toBeNull();
  });

  it.each([
    ['leitura que falha', { data: null, error: { message: 'rede' } }],
    ['resolvida por outro', { data: 'resolvida', error: null }],
    ['forma desconhecida', { data: { desfecho: 'concluida' }, error: null }],
  ])('banco sem prova de nada (%s): divergente (fail-closed)', async (_nome, resposta) => {
    posseMock.encerrar = resposta;
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: 'true' }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('banco diz em_voo e depois concluida: a tela RECONSULTA e confirma o sucesso (Codex no diff)', async () => {
    posseMock.encerrar = [{ data: 'em_voo', error: null }, { data: 'em_voo', error: null }, { data: 'concluida', error: null }];
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Failed to send a request to the Edge Function' } } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(encerramentos()).toHaveLength(3);
    expect(navigateSpy).toHaveBeenCalledWith('/sales');
    const { estadoDoPedido } = await import('../registroEnvios');
    expect(estadoDoPedido('ord-1').divergente).toBe(false);
  });

  it('em_voo que não termina: trava EM ANDAMENTO (recarregar depois), sem gravar divergente na aba', async () => {
    posseMock.encerrar = { data: 'em_voo', error: null };
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Failed to send a request to the Edge Function' } } as never);
    await act(async () => { await result.current.handleSave(); });
    const { PRAZOS } = await import('../envioEdicao');
    expect(encerramentos()).toHaveLength(PRAZOS.reconsultas + 1);
    expect(result.current.precisaRecarregar?.mensagem).toContain('ainda está processando');
    const { estadoDoPedido } = await import('../registroEnvios');
    expect(estadoDoPedido('ord-1').divergente).toBe(false);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('divergente guardado na aba sai quando o banco diz LIVRE ao reabrir (o banco é a verdade)', async () => {
    posseMock.encerrar = { data: null, error: { message: 'rede' } };
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Failed to send a request to the Edge Function' } } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    mockedInvoke.mockResolvedValue({ data: { formas: [] }, error: null } as never);
    await act(async () => { await result.current.recarregar(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.precisaRecarregar).toBeNull();
    expect(result.current.formularioTravado).toBe(false);
  });

  it('blocked edicao_divergente da edge: trava divergente e busca o token no banco, sem zerar a tela', async () => {
    const { result } = await renderLoaded();
    posseMock.estado = { data: { situacao: 'divergente', token: 'tok-9', motivo: 'x' }, error: null };
    mockedInvoke.mockResolvedValue({ data: { success: false, blocked: 'edicao_divergente', motivo: 'm' }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    expect(result.current.divergenciaDuravel).toEqual({ token: 'tok-9', motivo: 'x' });
    expect(result.current.order).not.toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('ao abrir: PV divergente no banco trava com o token; employee NÃO libera', async () => {
    posseMock.estado = { data: { situacao: 'divergente', token: 'tok-1', motivo: 'Omie recusou o item 2' }, error: null };
    const { result } = await renderLoaded();
    expect(result.current.precisaRecarregar?.tipo).toBe('divergente');
    expect(result.current.divergenciaDuravel).toEqual({ token: 'tok-1', motivo: 'Omie recusou o item 2' });
    expect(result.current.podeLiberarDivergencia).toBe(false);
    expect(result.current.formularioTravado).toBe(true);
    mockedInvoke.mockClear();
    await act(async () => { await result.current.handleSave(); });
    expect(bodyDoAlterar()).toBeUndefined();
  });

  it('master libera a divergência VISTA (pelo token) e a tela relê o pedido destravada', async () => {
    authMock.isMaster = true;
    posseMock.estado = { data: { situacao: 'divergente', token: 'tok-1', motivo: null }, error: null };
    const { result } = await renderLoaded();
    expect(result.current.podeLiberarDivergencia).toBe(true);
    posseMock.estado = { data: { situacao: 'livre' }, error: null };
    await act(async () => { await result.current.liberarDivergencia(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const resolver = posseMock.chamadas.filter((c) => c.nome === 'pedido_edicao_omie_resolver');
    expect(resolver).toEqual([{ nome: 'pedido_edicao_omie_resolver', args: { p_sales_order_id: 'ord-1', p_token: 'tok-1' } }]);
    expect(result.current.precisaRecarregar).toBeNull();
    expect(result.current.formularioTravado).toBe(false);
  });

  it('ao abrir: edição em curso em outra aba/aparelho trava (recarregar depois)', async () => {
    posseMock.estado = { data: { situacao: 'em_voo' }, error: null };
    const { result } = await renderLoaded();
    expect(result.current.precisaRecarregar?.tipo).toBe('concorrente');
    expect(result.current.precisaRecarregar?.mensagem).toContain('outra aba ou aparelho');
    expect(result.current.formularioTravado).toBe(true);
  });

  it('ao abrir: leitura da posse que falha TRAVA (fail-closed)', async () => {
    posseMock.estado = { data: null, error: { message: 'função não existe' } };
    const { result } = await renderLoaded();
    expect(result.current.precisaRecarregar?.mensagem).toContain('Não consegui conferir');
    expect(result.current.formularioTravado).toBe(true);
  });

  it('blocked edicao_em_curso da edge: trava em curso, sem navegar', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockResolvedValue({ data: { success: false, blocked: 'edicao_em_curso', motivo: 'outro salvando' }, error: null } as never);
    await act(async () => { await result.current.handleSave(); });
    expect(result.current.precisaRecarregar?.mensagem).toContain('outra aba ou aparelho');
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(encerramentos()).toHaveLength(0); // recusa conhecida antes do Omie: nada a perguntar
  });
});
