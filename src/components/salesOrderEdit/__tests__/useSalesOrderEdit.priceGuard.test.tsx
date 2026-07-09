// Guard money-path imperativo em handleSave: um item de produto com valor_unitario <= 0
// NÃO pode persistir nem agendar o sync ao Omie. O input do card faz Number(value) || 0,
// então esvaziar o campo vira 0 silencioso (PV com valor zerado = prejuízo / pedido
// inválido). Botão desabilitado é só conveniência; o bloqueio real vive no handleSave.
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
// PR0.0-bis: loadOrder busca o omie_payload pelo canal staff SECDEF (fechado ao .select()).
const mockedRpc = vi.mocked(supabase.rpc);

/** Builder auto-retornante até `.range()` — o catálogo de edição agora é PAGINADO
 *  (select → eq → eq → or[exclusão] → order → order → range). Catálogo vazio basta:
 *  estes testes exercitam o guard de preço no save, não o catálogo. */
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
  // omie_products — catálogo paginado (builder auto-retornante até `.range()`)
  return emptyProductsBuilder();
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSpy.mockReturnValue({ eq: updateEqSpy });
  mockedInvoke.mockResolvedValue({ data: { formas: [] }, error: null } as never);
  mockedRpc.mockResolvedValue({ data: [{ id: 'ord-1', omie_payload: null, omie_response: null }], error: null } as never);
  mockedFrom.mockImplementation((table) => chainFor(table as string) as never);
});

async function renderLoaded() {
  const hook = renderHook(() => useSalesOrderEdit());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(hook.result.current.order).toBeTruthy());
  return hook;
}

describe('useSalesOrderEdit — guard de preço ao salvar', () => {
  it('BLOQUEIA salvar quando um item fica com valor_unitario 0 (não persiste, não sincroniza)', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockClear(); // descarta as chamadas do load (listar_formas)
    updateSpy.mockClear();

    act(() => {
      result.current.updateItem(0, 'valor_unitario', 0);
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.error).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'omie-vendas-sync',
      expect.objectContaining({ body: expect.objectContaining({ action: 'alterar_pedido' }) }),
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('BLOQUEIA salvar com valor_unitario negativo', async () => {
    const { result } = await renderLoaded();
    updateSpy.mockClear();

    act(() => {
      result.current.updateItem(0, 'valor_unitario', -5);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.error).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('expõe os índices inválidos para a UI destacar e travar o botão', async () => {
    const { result } = await renderLoaded();
    expect(result.current.invalidPriceItemIndices).toEqual([]);

    act(() => {
      result.current.updateItem(0, 'valor_unitario', 0);
    });

    expect(result.current.invalidPriceItemIndices).toEqual([0]);
  });

  it('PERMITE salvar quando todos os preços são > 0 (caminho feliz não regride)', async () => {
    const { result } = await renderLoaded();
    mockedInvoke.mockClear();
    updateSpy.mockClear();

    await act(async () => {
      await result.current.handleSave();
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/sales'));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
