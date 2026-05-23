import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivityColumn } from '../ActivityColumn';
import type { Customer, PreferredQuery, OrdersQuery, InteractionsQuery } from '../viewTypes';

const customer = { user_id: 'u1' } as unknown as Customer;
const emptyPreferred = { data: [], isLoading: false } as unknown as PreferredQuery;
const emptyInteractions = { data: [], isLoading: false } as unknown as InteractionsQuery;

const ordersQ = {
  data: [{ id: 'ord-aaaaaaaa', omie_numero_pedido: '123', created_at: '2026-01-10', account: 'oben', total: 500, status: 'faturado' }],
  isLoading: false,
} as unknown as OrdersQuery;
const noOrders = { data: [], isLoading: false } as unknown as OrdersQuery;

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
});
