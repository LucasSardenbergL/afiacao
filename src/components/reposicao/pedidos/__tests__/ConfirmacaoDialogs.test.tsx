import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemoverItemDialog, DescontinuarItemDialog } from '../ConfirmacaoDialogs';
import type { PedidoItem } from '../types';

const item = { id: 3, sku_codigo_omie: '777', sku_descricao: 'Catalisador' } as unknown as PedidoItem;

describe('RemoverItemDialog', () => {
  it('fechado (item null) não renderiza título', () => {
    render(<RemoverItemDialog item={null} onOpenChange={() => {}} pending={false} onConfirm={() => {}} />);
    expect(screen.queryByText('Remover este item do pedido?')).toBeNull();
  });

  it('aberto: mostra SKU e dispara onConfirm', () => {
    const onConfirm = vi.fn();
    render(<RemoverItemDialog item={item} onOpenChange={() => {}} pending={false} onConfirm={onConfirm} />);
    expect(screen.getByText('Remover este item do pedido?')).toBeTruthy();
    expect(screen.getByText('777')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Remover$/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('DescontinuarItemDialog', () => {
  it('aberto: mostra título de descontinuação e dispara onConfirm', () => {
    const onConfirm = vi.fn();
    render(<DescontinuarItemDialog item={item} onOpenChange={() => {}} pending={false} onConfirm={onConfirm} />);
    expect(screen.getByText('Descontinuar SKU permanentemente?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Descontinuar e remover/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('desabilita ações quando pending', () => {
    render(<DescontinuarItemDialog item={item} onOpenChange={() => {}} pending onConfirm={() => {}} />);
    expect(screen.getByRole('button', { name: /Descontinuar e remover/ })).toHaveProperty('disabled', true);
  });
});
