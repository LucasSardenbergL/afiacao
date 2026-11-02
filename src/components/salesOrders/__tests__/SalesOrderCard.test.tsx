import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SalesOrderCard } from '../SalesOrderCard';
import type { OrderFeedRow } from '../types';

// O card consome a linha da view order_feed (listagem enxuta).
function order(p: Partial<OrderFeedRow> = {}): OrderFeedRow {
  return {
    origin: 'sales',
    id: 'o1',
    created_at: '2026-05-20T10:00:00Z',
    account: 'oben',
    order_number: '000123',
    omie_pedido_id: 9,
    customer_user_id: 'u1',
    customer_name: 'ACME Ltda',
    item_names: ['Verniz'],
    item_quantity: 2,
    status: 'enviado',
    subtotal: 100,
    total: 100,
    ...p,
  };
}

function setup(o: OrderFeedRow, overrides: Partial<React.ComponentProps<typeof SalesOrderCard>> = {}) {
  const props: React.ComponentProps<typeof SalesOrderCard> = {
    order: o,
    customerName: 'ACME Ltda',
    checked: false,
    onSelectChange: vi.fn(),
    onShare: vi.fn(),
    onDelete: vi.fn(),
    onNavigate: vi.fn(),
    onOpenDetail: vi.fn(),
    onPrint: vi.fn(),
    ...overrides,
  };
  render(<SalesOrderCard {...props} />);
  return props;
}

describe('SalesOrderCard (sales)', () => {
  it('renderiza cliente, empresa, status, total, itens e PV', () => {
    setup(order());
    expect(screen.getByText('ACME Ltda')).toBeTruthy();
    expect(screen.getByText('Oben')).toBeTruthy();
    expect(screen.getByText('Enviado ao Omie')).toBeTruthy();
    expect(screen.getByText('R$ 100.00')).toBeTruthy();
    expect(screen.getByText('2 itens')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy(); // PV sem zeros à esquerda
  });

  it('checkbox dispara onSelectChange sem navegar', () => {
    const props = setup(order());
    fireEvent.click(screen.getByRole('checkbox'));
    expect(props.onSelectChange).toHaveBeenCalledWith(true);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('botões de compartilhar e editar disparam os handlers', () => {
    const props = setup(order());
    fireEvent.click(screen.getByTitle('Compartilhar via WhatsApp'));
    fireEvent.click(screen.getByTitle('Editar pedido'));
    expect(props.onShare).toHaveBeenCalledTimes(1);
    expect(props.onNavigate).toHaveBeenCalledWith('/sales/edit/o1');
  });

  it('clicar no card (venda) abre o detalhe — não navega', () => {
    const props = setup(order());
    fireEvent.click(screen.getByText('ACME Ltda'));
    expect(props.onOpenDetail).toHaveBeenCalledTimes(1);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('botão imprimir dispara onPrint sem abrir o detalhe', () => {
    const props = setup(order());
    fireEvent.click(screen.getByTitle('Imprimir pedido'));
    expect(props.onPrint).toHaveBeenCalledTimes(1);
    expect(props.onOpenDetail).not.toHaveBeenCalled();
  });

  it('mostra imprimir mesmo em pedido faturado (vê e imprime, sem editar)', () => {
    setup(order({ status: 'faturado' }));
    expect(screen.getByTitle('Imprimir pedido')).toBeTruthy();
    expect(screen.queryByTitle('Editar pedido')).toBeNull();
  });

  it('confirmar exclusão dispara onDelete', () => {
    const props = setup(order());
    // abre o AlertDialog pelo botão de lixeira (último botão do card)
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('não mostra editar quando status é faturado', () => {
    setup(order({ status: 'faturado' }));
    expect(screen.queryByTitle('Editar pedido')).toBeNull();
  });
});

describe('SalesOrderCard (afiação)', () => {
  it('mostra badges Colacor SC + Afiação e navega ao clicar no card', () => {
    // A view manda afiação com account='colacor_sc' e origin='afiacao'.
    const props = setup(order({ origin: 'afiacao', account: 'colacor_sc', order_number: null, omie_pedido_id: null, status: 'em_afiacao' }));
    expect(screen.getByText('Colacor SC')).toBeTruthy();
    expect(screen.getByText('Afiação')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); // não selecionável
    fireEvent.click(screen.getByText('ACME Ltda'));
    expect(props.onNavigate).toHaveBeenCalledWith('/orders/o1');
  });
});
