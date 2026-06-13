import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrderGroup } from '../OrderGroup';
import type { EnrichedOrder } from '../types';

const order: EnrichedOrder = {
  id: 'ord-1',
  _company: 'oben',
  customer_user_id: 'u1',
  items: [{ codigo: 'P1', descricao: 'X', quantidade: 1 }, { codigo: 'P2', descricao: 'Y', quantidade: 1 }],
  subtotal: 100,
  total: 100,
  status: 'aprovado',
  omie_numero_pedido: '000045',
  created_at: '2026-01-15T09:30:00',
  notes: null,
  customer_name: 'Cliente Alpha',
};

function noop() { /* */ }

describe('OrderGroup', () => {
  it('lista vazia → não renderiza nada (null)', () => {
    const { container } = render(
      <OrderGroup company="oben" period="manha" orders={[]} selectedOrders={new Set()} onToggleOrder={noop} onPrintSingle={noop} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renderiza período, número do pedido, cliente, total e contagem de itens', () => {
    render(
      <OrderGroup company="oben" period="manha" orders={[order]} selectedOrders={new Set()} onToggleOrder={noop} onPrintSingle={noop} />
    );
    expect(screen.getByText('Manhã')).toBeTruthy();
    expect(screen.getByText('#45')).toBeTruthy();
    expect(screen.getByText('Cliente Alpha')).toBeTruthy();
    expect(screen.getByText('2 itens')).toBeTruthy();
    expect(screen.getByText(/100,00/)).toBeTruthy();
  });

  it('hora: wizard (timestamp real) mostra HH:mm; sync (data-pura UTC) mostra "—" em vez de hora fabricada', () => {
    const sync: EnrichedOrder = { ...order, id: 'ord-2', omie_numero_pedido: '000046', created_at: '2026-06-10T00:00:00.000Z' };
    render(
      <OrderGroup company="oben" period="manha" orders={[order, sync]} selectedOrders={new Set()} onToggleOrder={noop} onPrintSingle={noop} />
    );
    expect(screen.getByText('09:30')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    // a hora local fabricada (21:00 em BRT) não pode aparecer
    expect(screen.queryByText('21:00')).toBeNull();
  });

  it('clique na linha chama onToggleOrder; botão imprimir chama onPrintSingle', () => {
    const onToggleOrder = vi.fn();
    const onPrintSingle = vi.fn();
    render(
      <OrderGroup company="oben" period="manha" orders={[order]} selectedOrders={new Set()} onToggleOrder={onToggleOrder} onPrintSingle={onPrintSingle} />
    );
    fireEvent.click(screen.getByText('Cliente Alpha'));
    expect(onToggleOrder).toHaveBeenCalledWith('ord-1');

    // O botão de imprimir é o único <button> da linha (Checkbox tem role checkbox)
    fireEvent.click(screen.getByRole('button'));
    expect(onPrintSingle).toHaveBeenCalledWith(order);
  });
});
