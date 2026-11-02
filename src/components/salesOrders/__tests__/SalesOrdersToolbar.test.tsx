import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SalesOrdersToolbar, BUSCA_DEBOUNCE_MS } from '../SalesOrdersToolbar';

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

  it('dispara setSearch UMA vez quando a digitação pausa (debounce), não a cada tecla', () => {
    vi.useFakeTimers();
    try {
      const props = setup();
      const input = screen.getByPlaceholderText(/Buscar por cliente/);
      for (const v of ['a', 'ac', 'acm', 'acme']) fireEvent.change(input, { target: { value: v } });
      expect((input as HTMLInputElement).value).toBe('acme');
      act(() => vi.advanceTimersByTime(BUSCA_DEBOUNCE_MS - 1));
      expect(props.setSearch).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(props.setSearch).toHaveBeenCalledTimes(1);
      expect(props.setSearch).toHaveBeenCalledWith('acme');
    } finally {
      vi.useRealTimers();
    }
  });

  it('busca limpa de fora (ex.: "Limpar filtros") esvazia o input', () => {
    const props = { onNavigate: vi.fn(), accountFilter: 'all' as const, setAccountFilter: vi.fn(), setSearch: vi.fn() };
    const { rerender } = render(<SalesOrdersToolbar {...props} search="acme" />);
    const input = screen.getByPlaceholderText(/Buscar por cliente/) as HTMLInputElement;
    expect(input.value).toBe('acme');
    rerender(<SalesOrdersToolbar {...props} search="" />);
    expect(input.value).toBe('');
  });

  it('renderiza as 4 abas de empresa', () => {
    setup();
    expect(screen.getByRole('tab', { name: 'Todos' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Oben/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Colacor SC/ })).toBeTruthy();
  });
});
