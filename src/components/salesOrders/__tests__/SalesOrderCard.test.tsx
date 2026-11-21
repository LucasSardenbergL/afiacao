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
    onPedirExclusao: vi.fn(),
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
    // pt-BR: vírgula decimal (antes saía "R$ 100.00"); \u00a0 = espaço do Intl.
    expect(screen.getByText(/^R\$\s100,00$/)).toBeTruthy();
    expect(screen.getByText('2 itens')).toBeTruthy();
    expect(screen.getByText('123')).toBeTruthy(); // PV sem zeros à esquerda
  });

  it('checkbox dispara onSelectChange sem navegar', () => {
    // Rascunho sem PV: excluível → selecionável para o lote.
    const props = setup(order({ status: 'rascunho', omie_pedido_id: null }));
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

  it('excluir (rascunho sem PV) pede a exclusão à página com o "⋯" como gatilho de foco', () => {
    const props = setup(order({ status: 'rascunho', omie_pedido_id: null }));
    const gatilho = screen.getByRole('button', { name: /Mais ações do pedido 123/ });
    fireEvent.keyDown(gatilho, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Excluir/ }));
    expect(props.onPedirExclusao).toHaveBeenCalledWith(gatilho);
    // A confirmação NÃO mora na linha (o clique no fundo dela abria o detalhe).
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(props.onOpenDetail).not.toHaveBeenCalled();
  });

  it.each([
    ['importado do Omie', { status: 'importado' }, /Importado do Omie/],
    ['já no Omie e não cancelado', { status: 'enviado', omie_pedido_id: 9 }, /cancele lá primeiro/],
    ['Colacor SC', { account: 'colacor_sc', status: 'rascunho', omie_pedido_id: null }, /Colacor SC não são excluídos/],
  ] as const)('%s: "Excluir" desabilitado com o motivo e sem checkbox', (_n, over, motivo) => {
    const props = setup(order(over));
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: /Mais ações/ }), { key: 'Enter' });
    const item = screen.getByRole('menuitem', { name: /Excluir/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(motivo)).toBeTruthy();
    fireEvent.click(item);
    expect(props.onPedirExclusao).not.toHaveBeenCalled();
  });

  it('concordância: 1 item (não "1 itens")', () => {
    setup(order({ item_quantity: 1 }));
    expect(screen.getByText('1 item')).toBeTruthy();
  });

  it('empresa desconhecida aparece como ela é — nunca vira "Oben"', () => {
    setup(order({ account: 'nova_empresa' }));
    expect(screen.getByText('nova_empresa')).toBeTruthy();
    expect(screen.queryByText('Oben')).toBeNull();
  });

  it('mostra a prévia dos produtos do pedido', () => {
    setup(order({ item_names: ['Verniz', 'Seladora', 'Thinner', 'Lixa'] }));
    expect(screen.getByText(/Verniz, Seladora \+2/)).toBeTruthy();
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
