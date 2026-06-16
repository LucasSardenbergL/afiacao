import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IdentityColumn } from '../IdentityColumn';
import type { Customer, CustomerScore, AddressQuery, ContactsQuery } from '../viewTypes';

const customer = {
  name: 'Acme', document: '12345678000190', user_id: 'u1', phone: '11999990000',
  email: 'a@x.com', customer_type: null,
} as unknown as Customer;

const emptyContacts = { data: [], isLoading: false } as unknown as ContactsQuery;
const oneAddress = {
  data: [{ label: 'OMIE', is_default: true, street: 'Rua A', number: '10', complement: null, neighborhood: 'Centro', city: 'SP', state: 'SP', zip_code: '01000000' }],
  isLoading: false,
} as unknown as AddressQuery;
const score = { priority_score: 80, expansion_score: 50, revenue_potential: 1000, avg_monthly_spend_180d: 500, category_count: 3 } as unknown as CustomerScore;

function renderCol(ui: React.ReactElement) {
  return render(<MemoryRouter><TooltipProvider>{ui}</TooltipProvider></MemoryRouter>);
}

describe('IdentityColumn', () => {
  it('renderiza cards de contato, endereço e score; contatos vazios → adicionar', () => {
    renderCol(
      <IdentityColumn customer={customer} isPj customerId="u1" contacts={emptyContacts} address={oneAddress} score={score} />
    );
    expect(screen.getByText('Contato')).toBeTruthy();
    expect(screen.getByText('Contatos extras')).toBeTruthy();
    expect(screen.getByText('Endereço')).toBeTruthy();
    expect(screen.getByText(/Nenhum contato extra cadastrado/)).toBeTruthy();
    expect(screen.getByText(/Rua A, 10/)).toBeTruthy();
    // endereço padrão exibido como "Principal"
    expect(screen.getByText('Principal')).toBeTruthy();
    // score
    expect(screen.getByText('Score comercial')).toBeTruthy();
    expect(screen.getByText('Prioridade')).toBeTruthy();
  });

  it('sem score → não renderiza card de score', () => {
    renderCol(
      <IdentityColumn customer={customer} isPj customerId="u1" contacts={emptyContacts} address={oneAddress} score={null} />
    );
    expect(screen.queryByText('Score comercial')).toBeNull();
  });
});
