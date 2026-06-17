// Regressão money-path do catálogo "Adicionar produto" da EDIÇÃO de PV:
//  (a) CONTA: filtra omie_products pela conta NORMALIZADA do pedido ('colacor'|'oben') —
//      a MESMA convenção que omie_products.account armazena; nunca a conta Omie de origem
//      'colacor_vendas' (0 linhas → vendedor não conseguia adicionar NADA num PV colacor).
//  (b) PAGINAÇÃO: o PostgREST capa em 1000 linhas/request e a busca é client-side; sem
//      paginar, ~1140 dos 2140 produtos colacor ativos ficariam invisíveis pra venda.
//  Os dois espelham o caminho de CRIAÇÃO (useProductCatalog: paginateAll + buildExclusionQuery).
//  O teste exercita o paginateAll/buildExclusionQuery REAIS contra um data source mockado.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'ord-1' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));

import { supabase } from '@/integrations/supabase/client';
import { useSalesOrderEdit } from '../useSalesOrderEdit';

const mockedFrom = vi.mocked(supabase.from);
const mockedInvoke = vi.mocked(supabase.functions.invoke);

/** Captura o valor passado a `.eq('account', X)` na query de omie_products. */
const productsAccountEq = vi.fn();

interface PgBuilder {
  select: () => PgBuilder;
  eq: (col?: string, val?: unknown) => PgBuilder;
  or: () => PgBuilder;
  order: () => PgBuilder;
  range: (from?: number, to?: number) => Promise<{ data: unknown[]; error: null }>;
}

/** Builder auto-retornante até `.range()` — resiliente à ordem do encadeamento real
 *  (select → eq(account) → eq(ativo) → or(exclusão) → order → order → range). `pageFor(from)`
 *  devolve a página daquele offset, deixando o paginateAll REAL iterar até esgotar. */
function omieProductsBuilder(pageFor: (from: number) => unknown[]): PgBuilder {
  const b = {} as PgBuilder;
  b.select = () => b;
  b.eq = (col, val) => { if (col === 'account') productsAccountEq(val); return b; };
  b.or = () => b;
  b.order = () => b;
  b.range = (from = 0) => Promise.resolve({ data: pageFor(from), error: null });
  return b;
}

function makeOrderRow(account: string) {
  return {
    id: 'ord-1',
    customer_user_id: 'cust-1',
    items: [
      { omie_codigo_produto: 1, codigo: 'C1', descricao: 'Lixa Grão 120', unidade: 'UN', quantidade: 1, valor_unitario: 10, valor_total: 10 },
    ],
    subtotal: 10, total: 10, status: 'pendente', notes: null, account,
    omie_pedido_id: 42, omie_numero_pedido: '1001', omie_payload: null, created_at: '2026-01-01',
  };
}

function chainFor(table: string, orderAccount: string, pageFor: (from: number) => unknown[]) {
  if (table === 'sales_orders') {
    return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: makeOrderRow(orderAccount), error: null }) }) }) };
  }
  if (table === 'profiles') {
    return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { name: 'Cliente X' }, error: null }) }) }) };
  }
  return omieProductsBuilder(pageFor);
}

function installMocks(orderAccount: string, pageFor: (from: number) => unknown[] = () => []) {
  mockedInvoke.mockResolvedValue({ data: { formas: [] }, error: null } as never);
  mockedFrom.mockImplementation((table) => chainFor(table as string, orderAccount, pageFor) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSalesOrderEdit — catálogo "Adicionar produto" (conta + paginação)', () => {
  it('PV colacor → filtra omie_products por account="colacor" (não "colacor_vendas")', async () => {
    installMocks('colacor');
    const { result } = renderHook(() => useSalesOrderEdit());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(productsAccountEq).toHaveBeenCalledWith('colacor');
    expect(productsAccountEq).not.toHaveBeenCalledWith('colacor_vendas');
  });

  it('PV oben → filtra omie_products por account="oben"', async () => {
    installMocks('oben');
    const { result } = renderHook(() => useSalesOrderEdit());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(productsAccountEq).toHaveBeenCalledWith('oben');
  });

  it('PAGINA o catálogo: produto além das 1000 primeiras linhas continua adicionável (busca)', async () => {
    // Página 1 = 1000 linhas (cheia → o paginateAll busca de novo); página 2 = 140 linhas,
    // uma com marcador único. Com .limit(1000) cru esse produto nunca carregaria e o
    // vendedor não conseguiria achá-lo na busca.
    const PAGE2 = Array.from({ length: 140 }, (_, i) => ({
      id: `p2-${i}`, omie_codigo_produto: 2000 + i,
      codigo: i === 7 ? 'PAGE2-MARKER' : `P2C${i}`,
      descricao: i === 7 ? 'ZZZ Produto Só Na Página Dois' : `Produto P2 ${i}`,
      unidade: 'UN', valor_unitario: 5, estoque: 1, ativo: true,
    }));
    const pageFor = (from: number): unknown[] =>
      from === 0
        ? Array.from({ length: 1000 }, (_, i) => ({
            id: `p1-${i}`, omie_codigo_produto: 1000 + i, codigo: `P1C${i}`,
            descricao: `Produto P1 ${i}`, unidade: 'UN', valor_unitario: 5, estoque: 1, ativo: true,
          }))
        : PAGE2;

    installMocks('colacor', pageFor);
    const { result } = renderHook(() => useSalesOrderEdit());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.setProductSearch('PAGE2-MARKER'); });

    expect(result.current.filteredProducts).toHaveLength(1);
    expect(result.current.filteredProducts[0]).toMatchObject({ codigo: 'PAGE2-MARKER' });
  });
});
