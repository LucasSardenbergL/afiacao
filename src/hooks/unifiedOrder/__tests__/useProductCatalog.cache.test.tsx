/**
 * Testes de comportamento do #14 (Onda 2): catálogo do wizard em React Query.
 * Travam os 3 contratos da otimização:
 *  1. reabrir o wizard dentro da janela de staleTime NÃO re-baixa o catálogo
 *     (a versão useState re-baixava ~8 páginas × 2 contas por mount);
 *  2. cold-start: catálogo local vazio dispara o sync paginado via edge e
 *     re-busca;
 *  3. o sync de estoque roda no máximo 1× por conta por janela POR SESSÃO
 *     (a versão anterior invocava sync_estoque no Omie a cada abertura).
 *
 * vi.resetModules + dynamic import por teste: o módulo guarda estado de
 * sessão (queue/janela do stock sync) de propósito — cada teste começa limpo
 * via __resetCatalogSessionStateForTests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

/* ─── Mock do supabase: catálogo (responder configurável) + edge functions ─── */
type ProductRow = Record<string, unknown>;
const state: {
  responder: () => ProductRow[];
  catalogFetches: number;
  invokes: Array<{ action: string; account: string }>;
  eqCalls: Array<[string, unknown]>;
} = { responder: () => [], catalogFetches: 0, invokes: [], eqCalls: [] };

vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        state.eqCalls.push([col, val]);
        return b;
      },
      or: () => b,
      not: () => b,
      order: () => b,
      range: (_from: number, _to: number) => {
        state.catalogFetches += 1;
        return Promise.resolve({ data: state.responder(), error: null });
      },
    };
    return b;
  };
  return {
    supabase: {
      from: () => builder(),
      functions: {
        invoke: (_fn: string, opts: { body: { action: string; account: string } }) => {
          state.invokes.push({ action: opts.body.action, account: opts.body.account });
          // 1 página e termina (nextPage null)
          return Promise.resolve({ data: { nextPage: null }, error: null });
        },
      },
    },
  };
});

const PRODUTO: ProductRow = {
  id: 'p1',
  codigo: 'PRD1',
  descricao: 'Produto 1',
  unidade: 'UN',
  valor_unitario: 10,
  estoque: 5,
  ativo: true,
  omie_codigo_produto: 111,
  account: 'oben',
  is_tintometric: false,
  tint_type: null,
  metadata: null,
  tipo_produto: null,
};

const OPTS = {
  enabled: true,
  customerPricesOben: {},
  customerPricesColacor: {},
  customerPurchaseHistory: {},
};

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

async function importFresh() {
  vi.resetModules();
  const mod = await import('@/hooks/unifiedOrder/useProductCatalog');
  mod.__resetCatalogSessionStateForTests();
  return mod;
}

describe('useProductCatalog (#14 — cache React Query)', () => {
  beforeEach(() => {
    state.responder = () => [PRODUTO];
    state.catalogFetches = 0;
    state.invokes = [];
    state.eqCalls = [];
  });

  it('o fetch do catálogo filtra ativo=true (não oferece produto inativo no wizard)', async () => {
    const { useProductCatalog } = await importFresh();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(() => useProductCatalog(OPTS), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.loadingObenProducts).toBe(false));
    // Money-path: a query base do catálogo precisa carregar o filtro de ativo.
    expect(state.eqCalls).toContainEqual(['ativo', true]);
    unmount();
  });

  it('reabrir o wizard dentro da janela usa o CACHE (remount não re-baixa o catálogo)', async () => {
    const { useProductCatalog } = await importFresh();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = makeWrapper(client);

    const first = renderHook(() => useProductCatalog(OPTS), { wrapper });
    await waitFor(() => expect(first.result.current.loadingObenProducts).toBe(false));
    expect(first.result.current.obenProducts.length).toBe(1);
    first.unmount();

    // Espera o background stock sync (1×/conta) drenar pra contagem ficar estável.
    await waitFor(() => {
      expect(state.invokes.filter((i) => i.action === 'sync_estoque').length).toBe(2);
    });
    const fetchesAntesDoRemount = state.catalogFetches;

    // Remount (mesma sessão/QueryClient): catálogo fresco no cache → zero fetch.
    const second = renderHook(() => useProductCatalog(OPTS), { wrapper });
    await waitFor(() => expect(second.result.current.loadingObenProducts).toBe(false));
    expect(second.result.current.obenProducts.length).toBe(1);
    expect(state.catalogFetches).toBe(fetchesAntesDoRemount);
    second.unmount();
  });

  it('cold-start: catálogo local vazio dispara sync_products e re-busca', async () => {
    const { useProductCatalog } = await importFresh();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // 1º fetch de cada conta devolve vazio; após o sync, devolve o produto.
    let fetches = 0;
    state.responder = () => {
      fetches += 1;
      return fetches <= 2 ? [] : [PRODUTO]; // 2 contas × 1º fetch vazio
    };

    const { result, unmount } = renderHook(() => useProductCatalog(OPTS), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.loadingObenProducts).toBe(false), {
      timeout: 4000,
    });

    expect(state.invokes.some((i) => i.action === 'sync_products')).toBe(true);
    expect(result.current.obenProducts.length).toBe(1);
    unmount();
  });

  it('sync de estoque roda no máximo 1×/conta por janela, mesmo com N remounts', async () => {
    const { useProductCatalog } = await importFresh();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = makeWrapper(client);

    const a = renderHook(() => useProductCatalog(OPTS), { wrapper });
    await waitFor(() => expect(a.result.current.loadingObenProducts).toBe(false));
    a.unmount();
    const b = renderHook(() => useProductCatalog(OPTS), { wrapper });
    await waitFor(() => expect(b.result.current.loadingObenProducts).toBe(false));
    b.unmount();

    // Aguarda a queue do background sync drenar.
    await waitFor(() => {
      expect(state.invokes.filter((i) => i.action === 'sync_estoque').length).toBeGreaterThan(0);
    });
    const syncsOben = state.invokes.filter(
      (i) => i.action === 'sync_estoque' && i.account === 'oben',
    );
    const syncsColacor = state.invokes.filter(
      (i) => i.action === 'sync_estoque' && i.account === 'colacor',
    );
    expect(syncsOben.length).toBe(1);
    expect(syncsColacor.length).toBe(1);
  });
});
