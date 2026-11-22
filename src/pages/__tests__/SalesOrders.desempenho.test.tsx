// /sales com 1.000 linhas: marcar UM checkbox não pode re-renderizar a lista inteira nem reagrupar
// por dia, e o alcance do lote só é calculado ao ABRIR o diálogo. A contagem de renders vem de uma
// espia no formatador do total (cada render de linha o chama 2×: aria-label e coluna Total) e o
// tempo, do React Profiler — os números ficam no PR (antes × depois).
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';
import type { OrderFeedRow } from '@/components/salesOrders/types';

const h = vi.hoisted(() => ({
  formatar: { n: 0 },
  agrupar: { n: 0 },
  alcance: { n: 0 },
}));

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/format', async () => {
  const real = await vi.importActual<typeof import('@/lib/format')>('@/lib/format');
  return {
    ...real,
    formatPrecoOuAusente: (...a: Parameters<typeof real.formatPrecoOuAusente>) => {
      h.formatar.n++;
      return real.formatPrecoOuAusente(...a);
    },
  };
});
vi.mock('@/components/salesOrders/types', async () => {
  const real = await vi.importActual<typeof import('@/components/salesOrders/types')>('@/components/salesOrders/types');
  return {
    ...real,
    agruparPorDia: (...a: Parameters<typeof real.agruparPorDia>) => {
      h.agrupar.n++;
      return real.agruparPorDia(...a);
    },
  };
});
vi.mock('@/components/salesOrders/alcance-exclusao', async () => {
  const real = await vi.importActual<typeof import('@/components/salesOrders/alcance-exclusao')>('@/components/salesOrders/alcance-exclusao');
  return {
    ...real,
    alcanceDaExclusao: (...a: Parameters<typeof real.alcanceDaExclusao>) => {
      h.alcance.n++;
      return real.alcanceDaExclusao(...a);
    },
  };
});

const N = 1000;
const ORDERS: OrderFeedRow[] = Array.from({ length: N }, (_, i) => ({
  origin: 'sales',
  id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  // 10 dias, 100 pedidos por dia
  created_at: new Date(Date.UTC(2026, 10, 21, 15) - Math.floor(i / 100) * 86_400_000 - (i % 100) * 60_000).toISOString(),
  account: i % 2 ? 'oben' : 'colacor',
  order_number: null,
  omie_pedido_id: null,
  customer_user_id: 'u1',
  customer_name: `Cliente ${i}`,
  item_names: ['Verniz'],
  item_quantity: 1,
  status: 'rascunho',
  subtotal: 10,
  total: 10 + i,
}));

// O hook de verdade devolve funções NOVAS a cada render (toggleSelect, printOrder…): o mock também,
// senão a medida mentiria a favor do memo.
vi.mock('@/components/salesOrders/useSalesOrders', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    useSalesOrders: () => {
      const [sel, setSel] = React.useState<Map<string, OrderFeedRow>>(new Map());
      const selectedIds = React.useMemo(() => new Set(sel.keys()), [sel]);
      return {
        navigate: () => {},
        authLoading: false, loading: false, loadError: null, refetchError: false, pausadoSemDados: false,
        dataUpdatedAt: 0, refetch: () => {}, buscando: false, hasNextPage: false, fetchNextPage: () => {},
        isFetchingNextPage: false, nextPageError: null,
        accountFilter: 'all', setAccountFilter: () => {}, statusFilter: 'todos', setStatusFilter: () => {},
        periodo: 'tudo', setPeriodo: () => {}, ordem: 'recentes', setOrdem: () => {},
        search: '', setSearch: () => {}, limparFiltros: () => {}, comFiltro: false,
        clienteFiltro: null, limparCliente: () => {},
        selectedIds,
        linhasSelecionadas: [...sel.values()],
        toggleSelect: (row: OrderFeedRow, v: boolean) => setSel((p) => {
          const n = new Map(p);
          if (v) n.set(row.id, row); else n.delete(row.id);
          return n;
        }),
        clearSelection: () => setSel(new Map()),
        orders: ORDERS,
        totalCount: N,
        deleteOrder: () => {}, deleteSelected: () => {},
        excluindoIds: new Set<string>(),
        handleShareOrder: () => {}, printOrder: () => {}, prefetchDetail: () => {},
      };
    },
  };
});
vi.mock('@/components/salesOrders/useSalesOrderDetail', () => ({
  useSalesOrderDetail: () => ({ data: undefined, isPending: true, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/components/salesOrders/useDescontosItensPedido', () => ({
  useDescontosItensPedido: () => ({ status: 'pending', fetchStatus: 'idle', data: undefined }),
}));

import SalesOrders from '@/pages/SalesOrders';

beforeAll(() => {
  if (!('IntersectionObserver' in globalThis)) {
    class IO { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
  }
});

let ms = 0;
const onRender: ProfilerOnRenderCallback = (_id, _fase, actual) => { ms += actual; };

function zerar() {
  h.formatar.n = 0;
  h.agrupar.n = 0;
  h.alcance.n = 0;
  ms = 0;
}

beforeEach(zerar);

function montar() {
  render(
    <MemoryRouter initialEntries={['/sales']}>
      <ShortcutsRegistryProvider>
        <Profiler id="sales" onRender={onRender}>
          <SalesOrders />
        </Profiler>
      </ShortcutsRegistryProvider>
    </MemoryRouter>,
  );
}

describe('/sales com 1.000 linhas — custo de marcar um checkbox', () => {
  it('re-renderiza só a linha marcada, não reagrupa e não calcula o alcance com o diálogo fechado', () => {
    montar();
    const montagem = { linhas: h.formatar.n / 2, ms };
    const caixas = screen.getAllByRole('checkbox');
    expect(caixas.length).toBeGreaterThanOrEqual(N);

    zerar();
    act(() => { fireEvent.click(caixas[0]); });
    const marcar = { linhas: h.formatar.n / 2, agrupar: h.agrupar.n, alcance: h.alcance.n, ms };
    zerar();
    act(() => { fireEvent.click(caixas[1]); });
    const marcar2 = { linhas: h.formatar.n / 2, agrupar: h.agrupar.n, alcance: h.alcance.n, ms };

    console.info('[desempenho /sales]', JSON.stringify({ montagem, marcar, marcar2 }));
    // Só a linha que mudou de `checked` renderiza (a barra de lote aparece na 1ª, mas é fora da lista).
    expect(marcar.linhas).toBeLessThanOrEqual(1);
    expect(marcar2.linhas).toBeLessThanOrEqual(1);
    expect(marcar.agrupar).toBe(0);
    expect(marcar.alcance).toBe(0);
    expect(marcar2.alcance).toBe(0);
  }, 120_000);

  it('o alcance do lote é calculado ao abrir o diálogo (e mostra a contagem certa)', () => {
    montar();
    const caixas = screen.getAllByRole('checkbox');
    act(() => { fireEvent.click(caixas[0]); });
    act(() => { fireEvent.click(caixas[1]); });
    zerar();
    act(() => { fireEvent.click(screen.getByRole('button', { name: /excluir/i })); });
    expect(h.alcance.n).toBe(1);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Excluir 2 pedidos?');
  }, 120_000);
});
