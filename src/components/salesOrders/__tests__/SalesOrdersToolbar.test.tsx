import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SalesOrdersToolbar, SalesOrdersAcoes, BUSCA_DEBOUNCE_MS } from '../SalesOrdersToolbar';

const filtrosNovos = () => ({
  statusFilter: 'todos' as const,
  setStatusFilter: vi.fn(),
  periodo: 'tudo' as const,
  setPeriodo: vi.fn(),
  ordem: 'recentes' as const,
  setOrdem: vi.fn(),
});

function setup(overrides: Partial<React.ComponentProps<typeof SalesOrdersToolbar>> = {}) {
  const props: React.ComponentProps<typeof SalesOrdersToolbar> = {
    accountFilter: 'all',
    setAccountFilter: vi.fn(),
    ...filtrosNovos(),
    search: '',
    setSearch: vi.fn(),
    ...overrides,
  };
  render(<SalesOrdersToolbar {...props} />);
  return props;
}

describe('SalesOrdersToolbar', () => {
  it('ações do cabeçalho navegam para novo pedido, catálogo e imprimir', () => {
    const onNavigate = vi.fn();
    render(<SalesOrdersAcoes onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Novo pedido/ }));
    fireEvent.click(screen.getByRole('button', { name: /Catálogo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Imprimir/ }));
    expect(onNavigate).toHaveBeenCalledWith('/sales/new');
    expect(onNavigate).toHaveBeenCalledWith('/sales/products');
    expect(onNavigate).toHaveBeenCalledWith('/sales/print');
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
    const props = { accountFilter: 'all' as const, setAccountFilter: vi.fn(), setSearch: vi.fn(), ...filtrosNovos() };
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

  it('chips de status: o ativo fica marcado e o clique sobe o grupo; "Rascunhos" vem em destaque', () => {
    const props = setup({ statusFilter: 'rascunhos' });
    const rascunhos = screen.getByRole('button', { name: 'Rascunhos' });
    expect(rascunhos.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Todos' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Faturados' }));
    expect(props.setStatusFilter).toHaveBeenCalledWith('faturados');
    expect(screen.getByRole('combobox', { name: 'Período' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Ordenar por' })).toBeTruthy();
  });
});
