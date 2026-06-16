import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddProductSearch } from '../AddProductSearch';
import type { OmieProduct } from '../types';

const prod: OmieProduct = {
  id: 'p1', omie_codigo_produto: 100, codigo: 'C1', descricao: 'Verniz incolor',
  unidade: 'UN', valor_unitario: 25, estoque: 8, ativo: true,
};

describe('AddProductSearch', () => {
  it('dispara setProductSearch ao digitar', () => {
    const setProductSearch = vi.fn();
    render(<AddProductSearch productSearch="" setProductSearch={setProductSearch} filteredProducts={[]} onAddProduct={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Buscar produto/), { target: { value: 'ver' } });
    expect(setProductSearch).toHaveBeenCalledWith('ver');
  });

  it('mostra dica quando < 2 caracteres', () => {
    render(<AddProductSearch productSearch="v" setProductSearch={vi.fn()} filteredProducts={[]} onAddProduct={vi.fn()} />);
    expect(screen.getByText('Digite pelo menos 2 caracteres')).toBeTruthy();
  });

  it('mostra "nenhum produto" quando >=2 e lista vazia', () => {
    render(<AddProductSearch productSearch="xyz" setProductSearch={vi.fn()} filteredProducts={[]} onAddProduct={vi.fn()} />);
    expect(screen.getByText('Nenhum produto encontrado')).toBeTruthy();
  });

  it('lista produtos e dispara onAddProduct ao clicar', () => {
    const onAddProduct = vi.fn();
    render(<AddProductSearch productSearch="ver" setProductSearch={vi.fn()} filteredProducts={[prod]} onAddProduct={onAddProduct} />);
    expect(screen.getByText('Verniz incolor')).toBeTruthy();
    fireEvent.click(screen.getByText('Verniz incolor'));
    expect(onAddProduct).toHaveBeenCalledWith(prod);
  });
});
