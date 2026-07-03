import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemoverItemDialog, DescontinuarItemDialog, RemoverItensLoteDialog } from '../ConfirmacaoDialogs';
import type { PedidoItem } from '../types';

const item = { id: 3, sku_codigo_omie: '777', sku_descricao: 'Catalisador' } as unknown as PedidoItem;

const itemLote = (id: number, sku: string) =>
  ({ id, sku_codigo_omie: sku, sku_descricao: `Produto ${sku}` }) as unknown as PedidoItem;

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

describe('RemoverItensLoteDialog', () => {
  it('fechado (null ou lista vazia) não renderiza título', () => {
    render(<RemoverItensLoteDialog itens={null} onOpenChange={() => {}} pending={false} onConfirm={() => {}} />);
    expect(screen.queryByText(/Remover .* itens do pedido\?/)).toBeNull();
    render(<RemoverItensLoteDialog itens={[]} onOpenChange={() => {}} pending={false} onConfirm={() => {}} />);
    expect(screen.queryByText(/Remover .* itens do pedido\?/)).toBeNull();
  });

  it('aberto: mostra contagem, lista até 5 SKUs e resume o excedente', () => {
    const itens = ['111', '222', '333', '444', '555', '666', '777'].map((sku, i) => itemLote(i + 1, sku));
    render(<RemoverItensLoteDialog itens={itens} onOpenChange={() => {}} pending={false} onConfirm={() => {}} />);
    expect(screen.getByText('Remover 7 itens do pedido?')).toBeTruthy();
    expect(screen.getByText('111')).toBeTruthy();
    expect(screen.getByText('555')).toBeTruthy();
    expect(screen.queryByText('666')).toBeNull();
    expect(screen.getByText(/\+2 outro\(s\)/)).toBeTruthy();
  });

  it('confirma dispara onConfirm; pending desabilita', () => {
    const onConfirm = vi.fn();
    const { unmount } = render(
      <RemoverItensLoteDialog itens={[itemLote(1, '111')]} onOpenChange={() => {}} pending={false} onConfirm={onConfirm} />,
    );
    expect(screen.getByText('Remover 1 item do pedido?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Remover 1 item$/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    unmount();

    render(<RemoverItensLoteDialog itens={[itemLote(1, '111')]} onOpenChange={() => {}} pending onConfirm={() => {}} />);
    expect(screen.getByRole('button', { name: /^Remover 1 item$/ })).toHaveProperty('disabled', true);
  });
});
