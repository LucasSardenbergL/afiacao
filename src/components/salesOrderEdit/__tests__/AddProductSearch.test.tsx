import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddProductSearch } from '../AddProductSearch';
import type { OmieProduct } from '../types';

const prod: OmieProduct = {
  id: 'p1', omie_codigo_produto: 100, codigo: 'C1', descricao: 'Verniz incolor',
  unidade: 'UN', valor_unitario: 25, estoque: 8, ativo: true, account: 'oben', is_tintometric: false, tint_type: null,
};

describe('AddProductSearch', () => {
  it('dispara setProductSearch ao digitar', () => {
    const setProductSearch = vi.fn();
    render(<AddProductSearch productSearch="" setProductSearch={setProductSearch} filteredProducts={[]} onAddProduct={vi.fn()} precoPrevisto={() => null} estadoCatalogo="ok" onTentarDeNovo={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Buscar produto/), { target: { value: 'ver' } });
    expect(setProductSearch).toHaveBeenCalledWith('ver');
  });

  it('mostra dica quando < 2 caracteres', () => {
    render(<AddProductSearch productSearch="v" setProductSearch={vi.fn()} filteredProducts={[]} onAddProduct={vi.fn()} precoPrevisto={() => null} estadoCatalogo="ok" onTentarDeNovo={vi.fn()} />);
    expect(screen.getByText('Digite pelo menos 2 caracteres')).toBeTruthy();
  });

  it('mostra "nenhum produto" quando >=2 e lista vazia', () => {
    render(<AddProductSearch productSearch="xyz" setProductSearch={vi.fn()} filteredProducts={[]} onAddProduct={vi.fn()} precoPrevisto={() => null} estadoCatalogo="ok" onTentarDeNovo={vi.fn()} />);
    expect(screen.getByText('Nenhum produto encontrado')).toBeTruthy();
  });

  it('lista produtos e dispara onAddProduct ao clicar', () => {
    const onAddProduct = vi.fn();
    render(<AddProductSearch productSearch="ver" setProductSearch={vi.fn()} filteredProducts={[prod]} onAddProduct={onAddProduct} precoPrevisto={() => 25} estadoCatalogo="ok" onTentarDeNovo={vi.fn()} />);
    expect(screen.getByText('Verniz incolor')).toBeTruthy();
    fireEvent.click(screen.getByText('Verniz incolor'));
    expect(onAddProduct).toHaveBeenCalledWith(prod);
  });

  it('mostra o preço que o clique APLICA (praticado), não a tabela; carregando = —', () => {
    const { rerender } = render(<AddProductSearch productSearch="ver" setProductSearch={vi.fn()} filteredProducts={[prod]} onAddProduct={vi.fn()} precoPrevisto={() => 87.5} estadoCatalogo="ok" onTentarDeNovo={vi.fn()} />);
    expect(screen.getByText('R$ 87.50')).toBeTruthy();
    expect(screen.queryByText('R$ 25.00')).toBeNull();
    rerender(<AddProductSearch productSearch="ver" setProductSearch={vi.fn()} filteredProducts={[prod]} onAddProduct={vi.fn()} precoPrevisto={() => null} estadoCatalogo="ok" onTentarDeNovo={vi.fn()} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('#28: catálogo que FALHOU não diz "Nenhum produto encontrado" — avisa e oferece tentar de novo', () => {
    const onTentarDeNovo = vi.fn();
    render(<AddProductSearch productSearch="verniz" setProductSearch={vi.fn()} filteredProducts={[]} onAddProduct={vi.fn()} precoPrevisto={() => null} estadoCatalogo="falhou" onTentarDeNovo={onTentarDeNovo} />);
    expect(screen.queryByText('Nenhum produto encontrado')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Não consegui carregar o catálogo');
    fireEvent.click(screen.getByText('Tentar de novo'));
    expect(onTentarDeNovo).toHaveBeenCalledTimes(1);
  });

  it('#28: catálogo carregando não afirma ausência', () => {
    render(<AddProductSearch productSearch="verniz" setProductSearch={vi.fn()} filteredProducts={[]} onAddProduct={vi.fn()} precoPrevisto={() => null} estadoCatalogo="carregando" onTentarDeNovo={vi.fn()} />);
    expect(screen.queryByText('Nenhum produto encontrado')).toBeNull();
    expect(screen.getByText('Carregando o catálogo…')).toBeTruthy();
  });
});
