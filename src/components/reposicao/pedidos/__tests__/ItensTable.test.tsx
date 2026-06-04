import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ItensTable } from '../ItensTable';
import type { Linha } from '../useDetalhesModal';

function linha(partial: Partial<Linha>): Linha {
  return {
    id: 1,
    pedido_id: 10,
    sku_codigo_omie: '555',
    sku_descricao: 'Verniz X',
    estoque_atual: 5,
    estoque_minimo: 2,
    ponto_pedido: 8,
    estoque_maximo: 20,
    qtde_sugerida: 10,
    qtde_final: null,
    preco_unitario: 3,
    valor_linha: null,
    primeira_compra: null,
    ajustado_humano: null,
    _qtd: 10,
    _preco: 3,
    _valor: 30,
    ...partial,
  } as Linha;
}

function setup(overrides: Partial<React.ComponentProps<typeof ItensTable>> = {}) {
  const props: React.ComponentProps<typeof ItensTable> = {
    linhas: [linha({})],
    podeEditar: true,
    totalAtual: 30,
    onEditQty: vi.fn(),
    podeEditarPreco: false,
    onEditPreco: vi.fn(),
    onRemover: vi.fn(),
    onDescontinuar: vi.fn(),
    removerPending: false,
    descontinuarPending: false,
    ...overrides,
  };
  render(<ItensTable {...props} />);
  return props;
}

describe('ItensTable', () => {
  it('renderiza SKU, descrição e total', () => {
    setup();
    expect(screen.getByText('555')).toBeTruthy();
    expect(screen.getByText('Verniz X')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('em modo editável: input dispara onEditQty e botões disparam ações', () => {
    const props = setup();
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    expect(props.onEditQty).toHaveBeenCalledWith(1, '7');

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]); // remover
    fireEvent.click(buttons[1]); // descontinuar
    expect(props.onRemover).toHaveBeenCalledTimes(1);
    expect(props.onDescontinuar).toHaveBeenCalledTimes(1);
  });

  it('sem permissão de edição: não há coluna Ações nem input', () => {
    setup({ podeEditar: false });
    expect(screen.queryByText('Ações')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('em modo leitura, destaca qtde final divergente da sugerida', () => {
    setup({ podeEditar: false, linhas: [linha({ _qtd: 4, qtde_sugerida: 10 })] });
    // 4 (qtd final divergente) é renderizado como span destacado
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('item sem custo + podeEditarPreco: mostra input de preço e dispara onEditPreco', () => {
    const onEditPreco = vi.fn();
    setup({
      podeEditar: false,
      podeEditarPreco: true,
      onEditPreco,
      linhas: [linha({ preco_unitario: 0, _preco: 0 })],
    });
    const precoInput = screen.getByPlaceholderText('custo');
    fireEvent.change(precoInput, { target: { value: '25.35' } });
    expect(onEditPreco).toHaveBeenCalledWith(1, '25.35');
  });

  it('item COM custo válido: preço fica read-only mesmo com podeEditarPreco', () => {
    setup({ podeEditar: false, podeEditarPreco: true, linhas: [linha({ preco_unitario: 9, _preco: 9 })] });
    expect(screen.queryByPlaceholderText('custo')).toBeNull();
  });
});
