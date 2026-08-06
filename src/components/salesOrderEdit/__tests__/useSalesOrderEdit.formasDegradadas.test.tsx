// Degradação da listagem de condições de pagamento (edge #1597) na EDIÇÃO de pedido.
// Sob fallback genérico, a condição REAL já gravada no pedido pode não estar na lista —
// o combobox então mostra rótulo vazio e convida o vendedor a escolher uma das 8 genéricas,
// TROCANDO o prazo de um pedido já negociado (DSO errado). O seletor trava; a proteção
// mesmo é o guard imperativo em handleSave (money-path §5).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'ord-1' }),
  useNavigate: () => navigateSpy,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, rpc: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useSalesOrderEdit } from '../useSalesOrderEdit';

const mockedFrom = vi.mocked(supabase.from);
const mockedInvoke = vi.mocked(supabase.functions.invoke);
const mockedRpc = vi.mocked(supabase.rpc);

interface PgBuilder {
  select: () => PgBuilder; eq: () => PgBuilder; or: () => PgBuilder; order: () => PgBuilder;
  range: () => Promise<{ data: unknown[]; error: null }>;
}
function emptyProductsBuilder(): PgBuilder {
  const b = {} as PgBuilder;
  b.select = () => b; b.eq = () => b; b.or = () => b; b.order = () => b;
  b.range = () => Promise.resolve({ data: [], error: null });
  return b;
}

const salesOrderRow = {
  id: 'ord-1',
  customer_user_id: 'cust-1',
  items: [
    { omie_codigo_produto: 1, codigo: 'C1', descricao: 'Lixa Grão 120', unidade: 'UN', quantidade: 2, valor_unitario: 10, valor_total: 20 },
  ],
  subtotal: 20, total: 20, status: 'pendente', notes: null, account: 'oben',
  omie_pedido_id: 42, omie_numero_pedido: '1001', omie_payload: null, created_at: '2026-01-01',
};

const updateEqSpy = vi.fn().mockResolvedValue({ error: null });
const updateSpy = vi.fn().mockReturnValue({ eq: updateEqSpy });

function chainFor(table: string) {
  if (table === 'sales_orders') {
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: salesOrderRow, error: null }),
        }),
      }),
      update: updateSpy,
    };
  }
  if (table === 'profiles') {
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { name: 'Cliente X' }, error: null }),
        }),
      }),
    };
  }
  return emptyProductsBuilder();
}

/** O pedido usa 'A17' (condição negociada); a lista de fallback NÃO a contém. */
const FORMAS_FALLBACK = [
  { codigo: '999', descricao: 'A Vista' },
  { codigo: '002', descricao: '30/60 dias' },
];
const FORMAS_OMIE = [...FORMAS_FALLBACK, { codigo: 'A17', descricao: '45/75/105 dias' }];

/** `staff_get_sales_order_payload` devolve o payload com a parcela gravada no pedido. */
function payloadComParcela(codigo: string | null) {
  return [{
    id: 'ord-1',
    omie_payload: codigo ? { cabecalho: { codigo_parcela: codigo } } : null,
    omie_response: null,
  }];
}

function mockFormas(resposta: Record<string, unknown>) {
  mockedInvoke.mockResolvedValue({ data: resposta, error: null } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSpy.mockReturnValue({ eq: updateEqSpy });
  mockedRpc.mockResolvedValue({ data: payloadComParcela('A17'), error: null } as never);
  mockedFrom.mockImplementation((table) => chainFor(table as string) as never);
});

async function renderLoaded() {
  const hook = renderHook(() => useSalesOrderEdit());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(hook.result.current.order).toBeTruthy());
  return hook;
}

describe('useSalesOrderEdit — condição de pagamento sob listagem degradada', () => {
  it('degradada E a condição do pedido ausente → trava o seletor e expõe o código', async () => {
    mockFormas({ formas: FORMAS_FALLBACK, source: 'fallback', degraded: true, motivo: 'rate limit' });
    const { result } = await renderLoaded();

    expect(result.current.formasDegradadas).toBe(true);
    expect(result.current.formasMotivo).toBe('rate limit');
    expect(result.current.condicaoDoPedidoAusente).toEqual(['A17']);
    expect(result.current.parcelaTravada).toBe(true);
  });

  it('degradada mas a condição do pedido ESTÁ na lista → avisa sem travar', async () => {
    mockedRpc.mockResolvedValue({ data: payloadComParcela('999'), error: null } as never);
    mockFormas({ formas: FORMAS_FALLBACK, source: 'fallback', degraded: true, motivo: null });
    const { result } = await renderLoaded();

    expect(result.current.formasDegradadas).toBe(true);
    expect(result.current.parcelaTravada).toBe(false);
  });

  // O par que prova o detector: mesmo código ausente, veredito oposto sem degradação.
  it('NÃO degradada e código ausente (parcela inativada no Omie) → não trava', async () => {
    mockFormas({ formas: FORMAS_FALLBACK, source: 'omie', degraded: false, motivo: null });
    const { result } = await renderLoaded();

    expect(result.current.formasDegradadas).toBe(false);
    expect(result.current.condicaoDoPedidoAusente).toEqual([]);
    expect(result.current.parcelaTravada).toBe(false);
  });

  // COMPATIBILIDADE (item 3): edge antiga / ainda não deployada.
  it('edge SEM os campos novos → não degradada, nada travado, nenhum aviso falso', async () => {
    mockFormas({ success: true, formas: FORMAS_OMIE });
    const { result } = await renderLoaded();

    expect(result.current.formasDegradadas).toBe(false);
    expect(result.current.formasErro).toBe(false);
    expect(result.current.parcelaTravada).toBe(false);
  });

  it('BLOQUEIA salvar se a parcela for trocada por uma genérica sob degradação', async () => {
    mockFormas({ formas: FORMAS_FALLBACK, source: 'fallback', degraded: true, motivo: null });
    const { result } = await renderLoaded();
    mockedInvoke.mockClear();
    updateSpy.mockClear();

    act(() => { result.current.setSelectedParcela('002'); });
    await act(async () => { await result.current.handleSave(); });

    expect(toast.error).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'omie-vendas-sync',
      expect.objectContaining({ body: expect.objectContaining({ action: 'alterar_pedido' }) }),
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('PERMITE salvar mantendo a condição original — ela vai íntegra ao Omie', async () => {
    mockFormas({ formas: FORMAS_FALLBACK, source: 'fallback', degraded: true, motivo: null });
    const { result } = await renderLoaded();
    mockedInvoke.mockClear();
    updateSpy.mockClear();
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);

    await act(async () => { await result.current.handleSave(); });

    expect(mockedInvoke).toHaveBeenCalledWith(
      'omie-vendas-sync',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'alterar_pedido', codigo_parcela: 'A17' }),
      }),
    );
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/sales'));
  });

  it('SEM degradação, trocar a parcela continua livre (o guard não vaza pro caminho bom)', async () => {
    mockFormas({ formas: FORMAS_OMIE, source: 'omie', degraded: false, motivo: null });
    const { result } = await renderLoaded();
    mockedInvoke.mockClear();
    mockedInvoke.mockResolvedValue({ data: { success: true }, error: null } as never);

    act(() => { result.current.setSelectedParcela('002'); });
    await act(async () => { await result.current.handleSave(); });

    expect(mockedInvoke).toHaveBeenCalledWith(
      'omie-vendas-sync',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'alterar_pedido', codigo_parcela: '002' }),
      }),
    );
  });

  // Metade do #1605, preservada na união e coberta aqui (ela mergeou sem teste próprio).
  // O throw dele vem DEPOIS do setOrder, então a tela abre: o toast é o sinal imediato, e
  // some. O estado de erro persistente é o que impede a tela de calar por omissão depois.
  it('erro do invoke (transporte) → toast E aviso persistente, sem lista de formas', async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'edge indisponível' } } as never);
    const { result } = await renderLoaded();

    expect(toast.error).toHaveBeenCalled();
    expect(result.current.formasErro).toBe(true);
    expect(result.current.formasMotivo).toBe('edge indisponível');
    expect(result.current.formas).toEqual([]);
    // Não é degradação declarada: a lista genérica nem chegou.
    expect(result.current.formasDegradadas).toBe(false);
  });

  // Distinto do acima: transporte OK (200), mas sem formas e sem degradação declarada —
  // ambíguo, então avisa em vez de sumir o card e sugerir "este pedido não tem condição".
  it('200 com lista VAZIA e sem degradação declarada → sinaliza erro sem derrubar a tela', async () => {
    mockFormas({ success: true, formas: [] });
    const { result } = await renderLoaded();

    expect(result.current.formasErro).toBe(true);
    expect(result.current.formasDegradadas).toBe(false);
    expect(result.current.order).toBeTruthy();
  });
});
