// Onda 2, item 8: a 360 é o destino único de "abrir cliente", e o "Cadastro e ferramentas" (a ficha
// antiga) é aberto DA 360, levando a fila de origem da lista. Sem isso o voltar do Cadastro caía na lista
// crua, perdendo o que a onda 1 consertou: busca, saúde, ordem e posição.
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IdentityColumn } from '../IdentityColumn';
import type { Customer, AddressQuery, ContactsQuery } from '../viewTypes';

const customer = {
  name: 'Acme', document: '12345678000190', user_id: 'u1', phone: '11999990000',
  email: 'a@x.com', customer_type: null,
} as unknown as Customer;
const semContatos = { data: [], isLoading: false } as unknown as ContactsQuery;
const semEndereco = { data: [], isLoading: false } as unknown as AddressQuery;

function Sonda() {
  const loc = useLocation();
  return <pre data-testid="sonda">{JSON.stringify({ path: loc.pathname, search: loc.search, state: loc.state })}</pre>;
}

function renderNa360(state: unknown) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/admin/customers/u1/360', state }]}>
      <TooltipProvider>
        <Routes>
          <Route
            path="/admin/customers/:id/360"
            element={
              <IdentityColumn customer={customer} isPj customerId="u1" contacts={semContatos} address={semEndereco} score={null} />
            }
          />
          <Route path="/admin/customers/:id" element={<Sonda />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const lerSonda = () => JSON.parse(screen.getByTestId('sonda').textContent ?? '{}');

describe('IdentityColumn — "Cadastro e ferramentas" leva a fila de origem', () => {
  it('veio da lista: o Cadastro abre com a fila na URL e a origem no state', () => {
    const origemLista = { query: '?search=acme&health=critico&ordem=nome', rolagem: 420 };
    renderNa360({ origemLista });
    fireEvent.click(screen.getByTestId('c360-link-cadastro'));
    expect(lerSonda()).toEqual({
      path: '/admin/customers/u1',
      search: '?search=acme&health=critico&ordem=nome',
      state: { origemLista },
    });
  });

  it('"Adicionar contato" também é o Cadastro, com a mesma origem', () => {
    const origemLista = { query: '?ordem=nome', rolagem: 10 };
    renderNa360({ origemLista });
    fireEvent.click(screen.getByRole('link', { name: /Adicionar contato/ }));
    expect(lerSonda()).toEqual({ path: '/admin/customers/u1', search: '?ordem=nome', state: { origemLista } });
  });

  it('sem origem (agenda, telefonia, link direto): Cadastro sem fila e sem state', () => {
    renderNa360(null);
    fireEvent.click(screen.getByTestId('c360-link-cadastro'));
    expect(lerSonda()).toEqual({ path: '/admin/customers/u1', search: '', state: null });
  });
});
