// Onda D: fora da carteira o servidor mascara o contato; a ficha DIZ isso, nunca mostra "—"
// (que afirmaria "cliente sem telefone"). Desconhecido (`null`) segue o ramo normal.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IdentityColumn } from '../IdentityColumn';
import type { Customer, ContactsQuery, AddressQuery } from '../viewTypes';

const vazio = { data: [], isLoading: false } as unknown as ContactsQuery;
const semEndereco = { data: [], isLoading: false } as unknown as AddressQuery;
const base = { name: 'Acme', user_id: 'u1', customer_type: null, document: null, email: null, phone: null };

function renderCom(extra: Record<string, unknown>) {
  const customer = { ...base, ...extra } as unknown as Customer;
  return render(
    <MemoryRouter><TooltipProvider>
      <IdentityColumn customer={customer} isPj={false} customerId="u1" contacts={vazio} address={semEndereco} score={null} />
    </TooltipProvider></MemoryRouter>,
  );
}

describe('IdentityColumn — contato restrito à carteira', () => {
  it('contatoVisivel=false: avisa e não renderiza as linhas de e-mail/telefone', () => {
    renderCom({ contatoVisivel: false });
    expect(screen.getByTestId('c360-contato-restrito').textContent).toBe('Contato visível só para a carteira deste cliente.');
    expect(screen.queryByText('Telefone')).toBeNull();
    expect(screen.queryByText('E-mail')).toBeNull();
  });
  it('contatoVisivel=true e sem dado: linhas normais, sem o aviso', () => {
    renderCom({ contatoVisivel: true });
    expect(screen.queryByTestId('c360-contato-restrito')).toBeNull();
    expect(screen.getByText('Telefone')).toBeTruthy();
  });
  it('contatoVisivel=null (desconhecido) não afirma restrição', () => {
    renderCom({ contatoVisivel: null });
    expect(screen.queryByTestId('c360-contato-restrito')).toBeNull();
  });
});
