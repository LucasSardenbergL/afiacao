import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrderItemCard } from '../OrderItemCard';
import type { OrderItem } from '../types';

function item(p: Partial<OrderItem> = {}): OrderItem {
  return {
    omie_codigo_produto: 100,
    codigo: 'C1',
    descricao: 'Verniz incolor',
    unidade: 'UN',
    quantidade: 2,
    valor_unitario: 25,
    valor_total: 50,
    ...p,
  };
}

describe('OrderItemCard', () => {
  it('renderiza descrição, código e total', () => {
    render(<OrderItemCard item={item()} index={0} isBlocked={false} onUpdate={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Verniz incolor')).toBeTruthy();
    expect(screen.getByText('Cód: C1')).toBeTruthy();
    expect(screen.getByText('R$ 50.00')).toBeTruthy();
  });

  it('mostra a cor tintométrica quando presente', () => {
    render(
      <OrderItemCard
        item={item({ tint_cor_id: 'RAL5005', tint_nome_cor: 'Azul' })}
        index={0}
        isBlocked={false}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText(/RAL5005 - Azul/)).toBeTruthy();
  });

  it('dispara onUpdate de quantidade e valor', () => {
    const onUpdate = vi.fn();
    render(<OrderItemCard item={item()} index={3} isBlocked={false} onUpdate={onUpdate} onRemove={vi.fn()} />);
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '5' } }); // qtd
    fireEvent.change(inputs[1], { target: { value: '30' } }); // valor
    expect(onUpdate).toHaveBeenCalledWith(3, 'quantidade', 5);
    expect(onUpdate).toHaveBeenCalledWith(3, 'valor_unitario', 30);
  });

  it('dispara onRemove com o índice', () => {
    const onRemove = vi.fn();
    render(<OrderItemCard item={item()} index={2} isBlocked={false} onUpdate={vi.fn()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it('quando bloqueado: sem botão remover e inputs desabilitados', () => {
    render(<OrderItemCard item={item()} index={0} isBlocked onUpdate={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).disabled).toBe(true);
  });
});
