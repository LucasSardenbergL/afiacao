// /sales pelo teclado: j/k movem a linha ativa, Enter abre, x seleciona SÓ o que a exclusão aceita,
// n abre um pedido novo, "/" foca a busca — tudo pelo registro de atalhos REAL (o mesmo do app).
// E o painel de detalhe, controlado sem trigger, devolve o foco à linha de onde abriu.
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';
import type { OrderFeedRow } from '@/components/salesOrders/types';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  toggleSelect: vi.fn(),
  setStatusFilter: vi.fn(),
  track: vi.fn(),
  toastInfo: vi.fn(),
  selected: new Set<string>(),
}));

vi.mock('@/lib/analytics', () => ({ track: h.track }));
vi.mock('sonner', () => ({ toast: { info: h.toastInfo, success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));

function pedido(p: Partial<OrderFeedRow>): OrderFeedRow {
  return {
    origin: 'sales',
    id: 'x',
    created_at: '2026-11-21T15:00:00Z',
    account: 'oben',
    order_number: null,
    omie_pedido_id: null,
    customer_user_id: 'u1',
    customer_name: 'Cliente',
    item_names: ['Verniz'],
    item_quantity: 1,
    origem_omie: false,
    status: 'rascunho',
    subtotal: 10,
    total: 10,
    ...p,
  };
}

// Mesmo dia (um grupo): a ordem na tela é a da lista.
const ORDERS: OrderFeedRow[] = [
  pedido({ id: 'a', customer_name: 'ALFA MÓVEIS', created_at: '2026-11-21T15:00:00Z' }),
  // Já no Omie e não cancelado: a edge recusaria a exclusão → não entra na seleção.
  pedido({ id: 'b', customer_name: 'BETA MARCENARIA', status: 'enviado', omie_pedido_id: 9, order_number: '000777', created_at: '2026-11-21T14:00:00Z' }),
  pedido({ id: 'c', customer_name: 'GAMA PISOS', created_at: '2026-11-21T13:00:00Z' }),
];

vi.mock('@/components/salesOrders/useSalesOrders', () => ({
  useSalesOrders: () => ({
    navigate: h.navigate,
    authLoading: false,
    loading: false,
    loadError: null,
    refetchError: false,
    pausadoSemDados: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
    buscando: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    nextPageError: null,
    accountFilter: 'all',
    setAccountFilter: vi.fn(),
    statusFilter: 'todos',
    setStatusFilter: h.setStatusFilter,
    periodo: 'tudo',
    setPeriodo: vi.fn(),
    ordem: 'recentes',
    setOrdem: vi.fn(),
    search: '',
    setSearch: vi.fn(),
    limparFiltros: vi.fn(),
    comFiltro: false,
    selectedIds: h.selected,
    linhasSelecionadas: [],
    toggleSelect: h.toggleSelect,
    clearSelection: vi.fn(),
    orders: ORDERS,
    totalCount: ORDERS.length,
    deleteOrder: vi.fn(),
    deleteSelected: vi.fn(),
    excluindoIds: new Set<string>(),
    handleShareOrder: vi.fn(),
    printOrder: vi.fn(),
    prefetchDetail: vi.fn(),
  }),
}));
// Detalhe em voo: o painel abre com o resumo da linha e o skeleton.
vi.mock('@/components/salesOrders/useSalesOrderDetail', () => ({
  useSalesOrderDetail: () => ({ data: undefined, isPending: true, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/components/salesOrders/useDescontosItensPedido', () => ({
  useDescontosItensPedido: () => ({ status: 'pending', fetchStatus: 'idle', data: undefined }),
}));

import SalesOrders from '@/pages/SalesOrders';

beforeAll(() => {
  // useInfiniteScroll observa o sentinela; o jsdom não tem IntersectionObserver.
  if (!('IntersectionObserver' in globalThis)) {
    class IO { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
  }
});

beforeEach(() => {
  h.navigate.mockReset();
  h.toggleSelect.mockReset();
  h.track.mockReset();
  h.toastInfo.mockReset();
});

function montar() {
  render(
    <MemoryRouter initialEntries={['/sales']}>
      <ShortcutsRegistryProvider>
        <SalesOrders />
      </ShortcutsRegistryProvider>
    </MemoryRouter>,
  );
}

const tecla = (key: string) => act(() => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
});
const linha = (nome: RegExp) => screen.getByRole('row', { name: nome });

describe('/sales — teclado', () => {
  it('a lista tem semântica de tabela, com cabeçalho de colunas para o leitor de tela', () => {
    montar();
    expect(screen.getByRole('table', { name: 'Pedidos' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Cliente' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Total' })).toBeTruthy();
  });

  it('roving tabindex: só a primeira linha fica no Tab antes de qualquer movimento', () => {
    montar();
    expect(linha(/ALFA/).getAttribute('tabindex')).toBe('0');
    expect(linha(/BETA/).getAttribute('tabindex')).toBe('-1');
    expect(linha(/GAMA/).getAttribute('tabindex')).toBe('-1');
  });

  it('j desce e k sobe a linha ativa (sem passar das pontas)', () => {
    montar();
    tecla('j');
    expect(document.activeElement).toBe(linha(/ALFA/));
    tecla('j');
    expect(document.activeElement).toBe(linha(/BETA/));
    expect(linha(/BETA/).getAttribute('tabindex')).toBe('0');
    expect(linha(/ALFA/).getAttribute('tabindex')).toBe('-1');
    tecla('j');
    tecla('j');
    expect(document.activeElement).toBe(linha(/GAMA/));
    tecla('k');
    expect(document.activeElement).toBe(linha(/BETA/));
  });

  it('↑/↓ com o foco na linha fazem o mesmo que k/j', () => {
    montar();
    tecla('j');
    tecla('ArrowDown');
    expect(document.activeElement).toBe(linha(/BETA/));
    tecla('ArrowUp');
    expect(document.activeElement).toBe(linha(/ALFA/));
  });

  it('x seleciona o pedido excluível em foco e mede via teclado', () => {
    montar();
    tecla('j');
    tecla('x');
    expect(h.toggleSelect).toHaveBeenCalledTimes(1);
    expect(h.toggleSelect.mock.calls[0][0].id).toBe('a');
    expect(h.toggleSelect.mock.calls[0][1]).toBe(true);
    expect(h.track).toHaveBeenCalledWith('sales.pedido_acao', { acao: 'selecionar', via: 'teclado' });
  });

  it('x anuncia a seleção e ignora a tecla segurada (auto-repeat)', () => {
    montar();
    tecla('j');
    tecla('x');
    expect(screen.getByText('Pedido selecionado').getAttribute('role')).toBe('status');
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'x', repeat: true });
    });
    expect(h.toggleSelect).toHaveBeenCalledTimes(1);
  });

  it('com o foco num controle FORA da lista, a letra é dele: não navega nem consome a tecla', () => {
    montar();
    const catalogo = screen.getByRole('button', { name: /Catálogo/ });
    catalogo.focus();
    let naoConsumida = true;
    act(() => {
      naoConsumida = fireEvent.keyDown(catalogo, { key: 'n' });
    });
    expect(naoConsumida).toBe(true); // sem preventDefault
    expect(h.navigate).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(catalogo, { key: 'j' });
    });
    expect(document.activeElement).toBe(catalogo);
  });

  it('setas com modificador não movem a linha (são do sistema/leitor de tela)', () => {
    montar();
    tecla('j');
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', altKey: true, ctrlKey: true });
    });
    expect(document.activeElement).toBe(linha(/ALFA/));
  });

  it('x NÃO seleciona pedido que a exclusão recusa — e diz por quê', () => {
    montar();
    tecla('j');
    tecla('j');
    tecla('x');
    expect(h.toggleSelect).not.toHaveBeenCalled();
    expect(h.toastInfo).toHaveBeenCalledTimes(1);
    expect(String(h.toastInfo.mock.calls[0][1]?.description)).toMatch(/Omie/);
  });

  it('x sem linha ativa não faz nada', () => {
    montar();
    tecla('x');
    expect(h.toggleSelect).not.toHaveBeenCalled();
    expect(h.toastInfo).not.toHaveBeenCalled();
  });

  it('n abre um novo pedido', () => {
    montar();
    tecla('n');
    expect(h.navigate).toHaveBeenCalledWith('/sales/new');
    expect(h.track).toHaveBeenCalledWith('sales.pedido_acao', { acao: 'novo', via: 'teclado' });
  });

  it('"/" foca a busca, e as letras dentro dela são texto (não atalho)', () => {
    montar();
    tecla('/');
    const busca = screen.getByRole('searchbox', { name: 'Buscar pedidos' });
    expect(document.activeElement).toBe(busca);
    tecla('n');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('Enter abre o painel com o resumo da linha e, ao fechar, o foco volta à linha', async () => {
    montar();
    tecla('j');
    tecla('j');
    tecla('Enter');
    const painel = await screen.findByRole('dialog');
    expect(painel.textContent).toContain('BETA MARCENARIA');
    expect(painel.textContent).toContain('777'); // PV do resumo, antes do detalhe chegar
    expect(screen.getByTestId('detalhe-carregando')).toBeTruthy();
    expect(h.track).toHaveBeenCalledWith('sales.pedido_aberto', { origem: 'teclado' });

    // Com o painel aberto, os atalhos da lista saem do ar.
    tecla('n');
    expect(h.navigate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(painel, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // O Radix devolve o foco num setTimeout(0) depois de desmontar.
    await waitFor(() => expect(document.activeElement).toBe(linha(/BETA/)));
  });
});
