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
    // O total da linha passou a usar `formatPrecoOuAusente` (Intl pt-BR) em vez de
    // `R$ ${v.toFixed(2)}`, que produzia "R$ 50.00" com PONTO decimal. O matcher é por
    // função porque o Intl usa espaço NÃO-QUEBRÁVEL depois de "R$", invisível na string.
    expect(screen.getByText((txt) => txt.replace(/\s/g, ' ') === 'R$ 50,00')).toBeTruthy();
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

  // P0 2026-11-25: com o input controlado pelo NÚMERO, "12." voltava como "12" e o dígito
  // seguinte formava 125 (preço 10x). O harness devolve ao card o valor que ele subiu, como o hook.
  it('digitar 12.5 tecla a tecla sobe 12.5 (não 125) e o texto não perde o ponto', () => {
    const onUpdate = vi.fn();
    const { rerender } = render(<OrderItemCard item={item()} index={0} isBlocked={false} onUpdate={onUpdate} onRemove={vi.fn()} />);
    const preco = screen.getByLabelText('Valor unitário') as HTMLInputElement;
    for (const parcial of ['1', '12', '12.', '12.5']) {
      fireEvent.change(preco, { target: { value: parcial } });
      const ultimo = onUpdate.mock.calls.at(-1)![2] as number;
      rerender(<OrderItemCard item={item({ valor_unitario: ultimo })} index={0} isBlocked={false} onUpdate={onUpdate} onRemove={vi.fn()} />);
      expect(preco.value).toBe(parcial);
    }
    expect(onUpdate).toHaveBeenLastCalledWith(0, 'valor_unitario', 12.5);
  });

  it('vírgula é decimal; vazio é preço NÃO sabido (null), nunca 0', () => {
    const onUpdate = vi.fn();
    render(<OrderItemCard item={item()} index={0} isBlocked={false} onUpdate={onUpdate} onRemove={vi.fn()} />);
    const preco = screen.getByLabelText('Valor unitário');
    fireEvent.change(preco, { target: { value: '12,5' } });
    expect(onUpdate).toHaveBeenLastCalledWith(0, 'valor_unitario', 12.5);
    fireEvent.change(preco, { target: { value: '' } });
    expect(onUpdate).toHaveBeenLastCalledWith(0, 'valor_unitario', null);
  });

  it('quantidade vazia ou ilegível sobe NaN (o guard recusa), não 1', () => {
    const onUpdate = vi.fn();
    render(<OrderItemCard item={item()} index={0} isBlocked={false} onUpdate={onUpdate} onRemove={vi.fn()} />);
    const qtd = screen.getByLabelText('Quantidade');
    fireEvent.change(qtd, { target: { value: '' } });
    expect(Number.isNaN(onUpdate.mock.calls.at(-1)![2])).toBe(true);
    fireEvent.change(qtd, { target: { value: '-3' } });
    expect(Number.isNaN(onUpdate.mock.calls.at(-1)![2])).toBe(true);
  });

  it('quantidade inválida marca o campo', () => {
    render(<OrderItemCard item={item({ quantidade: 0 })} index={0} isBlocked={false} isQuantityInvalid onUpdate={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText('Quantidade')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Quantidade maior que zero.')).toBeInTheDocument();
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
