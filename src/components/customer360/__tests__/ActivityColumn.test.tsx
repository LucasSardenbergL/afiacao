import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivityColumn } from '../ActivityColumn';
import { LIMITE_FEED_PEDIDOS } from '../format';
import type { Customer, PreferredQuery, OrdersQuery, InteractionsQuery } from '../viewTypes';

const customer = { user_id: 'u1' } as unknown as Customer;
const emptyPreferred = { data: [], isLoading: false } as unknown as PreferredQuery;
const emptyInteractions = { data: [], isLoading: false } as unknown as InteractionsQuery;

const ordersQ = {
  data: [{ id: 'ord-aaaaaaaa', omie_numero_pedido: '123', created_at: '2026-01-10', account: 'oben', total: 500, status: 'faturado' }],
  isLoading: false,
} as unknown as OrdersQuery;
const noOrders = { data: [], isLoading: false } as unknown as OrdersQuery;
const nPedidos = (n: number) =>
  ({
    data: Array.from({ length: n }, (_, i) => ({
      id: `ord-${String(i).padStart(8, '0')}`,
      omie_numero_pedido: String(1000 + i),
      created_at: '2026-01-10',
      account: 'oben',
      total: 10,
      status: 'faturado',
    })),
    isLoading: false,
  }) as unknown as OrdersQuery;

function renderCol(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ActivityColumn', () => {
  it('vazios → empty states de itens preferidos e contatos', () => {
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={noOrders} customer={customer} />);
    expect(screen.getByText('Itens preferidos')).toBeTruthy();
    expect(screen.getByText('Sem itens preferidos ainda')).toBeTruthy();
    expect(screen.getByText('Sem contatos recentes')).toBeTruthy();
    // sem pedidos → card de pedidos recentes não renderiza
    expect(screen.queryByText('Pedidos recentes')).toBeNull();
  });

  it('com pedidos → card de pedidos recentes com PV e total', () => {
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={ordersQ} customer={customer} />);
    expect(screen.getByText('Pedidos recentes')).toBeTruthy();
    expect(screen.getByText('PV 123')).toBeTruthy();
    expect(screen.getByText(/500,00/)).toBeTruthy();
  });

  it(`feed no TETO → "${LIMITE_FEED_PEDIDOS}+" no badge e no "Ver todos": o teto não é o total do cliente`, () => {
    renderCol(
      <ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={nPedidos(LIMITE_FEED_PEDIDOS)} customer={customer} />,
    );
    expect(screen.getByText(`${LIMITE_FEED_PEDIDOS}+`)).toBeTruthy();
    expect(screen.getByText(`Ver todos (${LIMITE_FEED_PEDIDOS}+)`)).toBeTruthy();
    expect(screen.queryByText(`Ver todos (${LIMITE_FEED_PEDIDOS})`)).toBeNull();
  });

  it('feed abaixo do teto → a contagem é o que veio, sem "+"', () => {
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={nPedidos(7)} customer={customer} />);
    expect(screen.getByText('Ver todos (7)')).toBeTruthy();
  });

  it('a leitura do feed que FALHOU fala — não some como se o cliente não tivesse pedidos', () => {
    const falhou = { data: undefined, status: 'error', fetchStatus: 'idle', isLoading: false } as unknown as OrdersQuery;
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={falhou} customer={customer} />);
    expect(screen.getByTestId('aviso-c360-pedidos-recentes').getAttribute('data-estado')).toBe('erro');
  });

  it('sem rede na 1ª carga do feed (pending + paused) também fala', () => {
    const semRede = { data: undefined, status: 'pending', fetchStatus: 'paused', isLoading: false } as unknown as OrdersQuery;
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={semRede} customer={customer} />);
    expect(screen.getByTestId('aviso-c360-pedidos-recentes').getAttribute('data-estado')).toBe('sem-rede');
  });

  it('lista VAZIA em mãos e o refetch do feed FALHOU: avisa que é leitura velha, em vez de afirmar "sem pedidos"', () => {
    const vaziaVelha = { data: [], status: 'error', fetchStatus: 'idle', isLoading: false } as unknown as OrdersQuery;
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={vaziaVelha} customer={customer} />);
    expect(screen.getByTestId('aviso-c360-pedidos-recentes-desatualizado').getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('aviso-c360-pedidos-recentes')).toBeNull();
  });

  it('lista em mãos e o refetch do feed ficou sem rede: a lista FICA e o aviso aparece junto', () => {
    const cheiaSemRede = { ...ordersQ, status: 'success', fetchStatus: 'paused' } as unknown as OrdersQuery;
    renderCol(<ActivityColumn preferred={emptyPreferred} interactions={emptyInteractions} orders={cheiaSemRede} customer={customer} />);
    expect(screen.getByText('PV 123')).toBeTruthy();
    expect(screen.getByTestId('aviso-c360-pedidos-recentes-desatualizado').getAttribute('data-estado')).toBe('sem-rede');
  });
});
