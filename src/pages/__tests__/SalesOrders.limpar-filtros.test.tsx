// /sales: busca sem resultado + "Limpar filtros" no EmptyState zera a busca E a aba de empresa, e a
// caixa de busca esvazia. O bug: o 2º set da URL regravava o `q` antigo (react-router 6 entrega
// os params DO RENDER ao updater), e a tela ficava presa em "Nenhum pedido com esses filtros".
//
// A fonte de dados é um fake, mas os filtros passam pelo useUrlState REAL e pela toolbar REAL. O
// limparFiltros do fake faz as DUAS escritas em sequência de propósito: é o formato que disparava o
// bug, então este teste também falha se o useUrlState voltar a não compor escritas no mesmo tick.
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUrlState } from '@/hooks/useUrlState';

const local = vi.hoisted(() => ({ search: '' }));

// A página lê só `isImpersonating` (altura do cabeçalho sticky); o provider real não interessa aqui.
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));

vi.mock('@/components/salesOrders/useSalesOrders', () => ({
  useSalesOrders: () => {
    const [filtros, setFiltros] = useUrlState({ q: '', empresa: 'all', status: 'todos', periodo: 'tudo', ordem: 'recentes' });
    const setSearch = (q: string) => setFiltros({ q });
    const setAccountFilter = (empresa: string) => setFiltros({ empresa });
    const setStatusFilter = (status: string) => setFiltros({ status });
    const setPeriodo = (periodo: string) => setFiltros({ periodo });
    const setOrdem = (ordem: string) => setFiltros({ ordem });
    return {
      navigate: vi.fn(),
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
      accountFilter: filtros.empresa,
      setAccountFilter,
      statusFilter: filtros.status,
      setStatusFilter,
      periodo: filtros.periodo,
      setPeriodo,
      ordem: filtros.ordem,
      setOrdem,
      search: filtros.q,
      setSearch,
      comFiltro: !!filtros.q || filtros.empresa !== 'all' || filtros.status !== 'todos' || filtros.periodo !== 'tudo',
      // Escritas em sequência de propósito (o formato que disparava o bug do useUrlState).
      limparFiltros: () => {
        setSearch('');
        setAccountFilter('all');
        setStatusFilter('todos');
        setPeriodo('tudo');
        setOrdem('recentes');
      },
      excluindoIds: new Set<string>(),
      selectedIds: new Set<string>(),
      linhasSelecionadas: [],
      toggleSelect: vi.fn(),
      clearSelection: vi.fn(),
      orders: [],
      totalCount: 0,
      deleteOrder: vi.fn(),
      deleteSelected: vi.fn(),
      handleShareOrder: vi.fn(),
      printOrder: vi.fn(),
      prefetchDetail: vi.fn(),
    };
  },
}));
vi.mock('@/components/salesOrders/useSalesOrderDetail', () => ({
  useSalesOrderDetail: () => ({ data: null, isLoading: false, error: null }),
}));
vi.mock('@/components/salesOrders/useDescontosItensPedido', () => ({
  useDescontosItensPedido: () => ({ data: null, isLoading: false, error: null }),
}));
vi.mock('@/components/salesOrders/SalesOrderDetailSheet', () => ({
  SalesOrderDetailSheet: () => null,
}));

import SalesOrders from '@/pages/SalesOrders';

function EspiaUrl() {
  local.search = useLocation().search;
  return null;
}

describe('SalesOrders — "Limpar filtros" no EmptyState', () => {
  it('zera busca e empresa numa ida e esvazia a caixa de busca', () => {
    render(
      <MemoryRouter initialEntries={['/sales?q=serra&empresa=oben']}>
        <SalesOrders />
        <EspiaUrl />
      </MemoryRouter>,
    );
    expect(screen.getByText('Nenhum pedido com esses filtros')).toBeTruthy();
    expect((screen.getByDisplayValue('serra') as HTMLInputElement).value).toBe('serra');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    });

    expect(screen.getByText('Nenhum pedido ainda')).toBeTruthy();
    expect(screen.queryByText('Nenhum pedido com esses filtros')).toBeNull();
    expect(screen.queryByDisplayValue('serra')).toBeNull();
    const params = new URLSearchParams(local.search);
    expect(params.get('q')).toBeNull();
    expect(params.get('empresa')).toBe('all');
  });

  it('filtro só de status/período também é "com filtros" e o Limpar zera os dois', () => {
    render(
      <MemoryRouter initialEntries={['/sales?status=rascunhos&periodo=hoje&ordem=valor']}>
        <SalesOrders />
        <EspiaUrl />
      </MemoryRouter>,
    );
    expect(screen.getByText('Nenhum pedido com esses filtros')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rascunhos' }).getAttribute('aria-pressed')).toBe('true');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    });
    expect(screen.getByText('Nenhum pedido ainda')).toBeTruthy();
    const params = new URLSearchParams(local.search);
    expect(params.get('status')).toBe('todos');
    expect(params.get('periodo')).toBe('tudo');
    expect(params.get('ordem')).toBe('recentes');
    expect(screen.getByRole('button', { name: 'Todos' }).getAttribute('aria-pressed')).toBe('true');
  });
});
