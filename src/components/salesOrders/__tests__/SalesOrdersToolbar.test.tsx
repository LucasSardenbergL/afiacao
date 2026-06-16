import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SalesOrdersToolbar } from '../SalesOrdersToolbar';

function setup(overrides: Partial<React.ComponentProps<typeof SalesOrdersToolbar>> = {}) {
  const props: React.ComponentProps<typeof SalesOrdersToolbar> = {
    onNavigate: vi.fn(),
    accountFilter: 'all',
    setAccountFilter: vi.fn(),
    search: '',
    setSearch: vi.fn(),
    ...overrides,
  };
  render(<SalesOrdersToolbar {...props} />);
  return props;
}

describe('SalesOrdersToolbar', () => {
  it('navega para novo pedido, catálogo e imprimir', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: /Novo Pedido/ }));
    fireEvent.click(screen.getByRole('button', { name: /Catálogo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Imprimir/ }));
    expect(props.onNavigate).toHaveBeenCalledWith('/sales/new');
    expect(props.onNavigate).toHaveBeenCalledWith('/sales/products');
    expect(props.onNavigate).toHaveBeenCalledWith('/sales/print');
  });

  it('dispara setSearch ao digitar', () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Buscar por cliente/), { target: { value: 'acme' } });
    expect(props.setSearch).toHaveBeenCalledWith('acme');
  });

  it('renderiza as 4 abas de empresa', () => {
    setup();
    expect(screen.getByRole('tab', { name: 'Todos' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Oben/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Colacor SC/ })).toBeTruthy();
  });
});
