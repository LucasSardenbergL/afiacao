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
    estoque_fisico: null,
    estoque_a_caminho: null,
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
    onBlurQty: vi.fn(),
    podeEditarPreco: false,
    onEditPreco: vi.fn(),
    onRemover: vi.fn(),
    onDescontinuar: vi.fn(),
    removerPending: false,
    descontinuarPending: false,
    selecionados: new Set<number>(),
    onToggleSelecionado: vi.fn(),
    onToggleTodos: vi.fn(),
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
    // sair do campo commita a quantidade ao múltiplo da embalagem (37 → 40 com fator 0,2) — o hook decide, a tabela avisa
    fireEvent.blur(input);
    expect(props.onBlurQty).toHaveBeenCalledWith(1);

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

  it('decompõe o efetivo em "físico + a caminho" quando há algo a caminho', () => {
    // efetivo 3 = 2 físico (saldo Omie) + 1 a caminho — o caso que confundia ("Omie diz 2, pedido diz 3")
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: 3, estoque_fisico: 2, estoque_a_caminho: 1 })] });
    expect(screen.getByText('3')).toBeTruthy(); // efetivo continua sendo o número principal (cor/decisão)
    expect(screen.getByText('2 + 1 a caminho')).toBeTruthy();
  });

  it('NÃO decompõe quando nada está a caminho (efetivo == físico)', () => {
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: 2, estoque_fisico: 2, estoque_a_caminho: 0 })] });
    expect(screen.queryByText(/a caminho/)).toBeNull();
  });

  it('item antigo (split NULL): cai no efetivo sem sublinha', () => {
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: 5, estoque_fisico: null, estoque_a_caminho: null })] });
    expect(screen.queryByText(/a caminho/)).toBeNull();
  });

  // [COMPROMETIDO] o motor desconta o vendido em pedido aberto no Omie (20261010210000): a conta exibida tem de
  // fechar com o efetivo — "12 + 0" ao lado de um efetivo 8 esconderia por que o item entrou na compra.
  it('mostra o vendido em aberto mesmo SEM nada a caminho: "12 − 4 vendido" fecha com o efetivo 8', () => {
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: 8, estoque_fisico: 12, estoque_a_caminho: 0, estoque_comprometido: 4 })] });
    const sub = screen.getByText('12 − 4 vendido');
    expect(sub.parentElement?.textContent).toBe('812 − 4 vendido'); // efetivo 8 + a sublinha, na mesma célula
    expect(screen.queryByText(/a caminho/)).toBeNull();
  });

  it('a caminho E vendido: "10 + 2 a caminho − 5 vendido"', () => {
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: 7, estoque_fisico: 10, estoque_a_caminho: 2, estoque_comprometido: 5 })] });
    expect(screen.getByText('10 + 2 a caminho − 5 vendido')).toBeTruthy();
  });

  it('efetivo NEGATIVO (vendido > físico) é exibido como é: 2 − 5 = −3', () => {
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: -3, estoque_fisico: 2, estoque_a_caminho: 0, estoque_comprometido: 5 })] });
    expect(screen.getByText('2 − 5 vendido').parentElement?.textContent).toBe('-32 − 5 vendido');
  });

  it('fração não some no arredondamento: 0,6 − 0,4 = 0,2 (não "1 − 0" nem "0"); −0,2 não vira "−0"', () => {
    setup({
      podeEditar: false,
      linhas: [
        linha({ id: 1, estoque_atual: 0.2, estoque_fisico: 0.6, estoque_a_caminho: 0, estoque_comprometido: 0.4 }),
        linha({ id: 2, sku_codigo_omie: '556', estoque_atual: -0.2, estoque_fisico: 0.2, estoque_a_caminho: 0, estoque_comprometido: 0.4 }),
      ],
    });
    expect(screen.getByText('0,6 − 0,4 vendido').parentElement?.textContent).toBe('0,20,6 − 0,4 vendido');
    expect(screen.getByText('0,2 − 0,4 vendido').parentElement?.textContent).toBe('-0,20,2 − 0,4 vendido');
  });

  it('vendido 0 ou NULL (desconto sem nada em aberto, ou SKU de grupo) não acrescenta nada', () => {
    setup({
      podeEditar: false,
      linhas: [
        linha({ id: 1, estoque_atual: 3, estoque_fisico: 2, estoque_a_caminho: 1, estoque_comprometido: 0 }),
        linha({ id: 2, sku_codigo_omie: '556', estoque_atual: 6, estoque_fisico: 6, estoque_a_caminho: 0, estoque_comprometido: null }),
      ],
    });
    expect(screen.getByText('2 + 1 a caminho')).toBeTruthy();
    expect(screen.queryByText(/vendido/)).toBeNull();
  });

  it('o tooltip do efetivo explica o desconto', () => {
    setup({ podeEditar: false, linhas: [linha({ estoque_atual: 8, estoque_fisico: 12, estoque_a_caminho: 0, estoque_comprometido: 4 })] });
    const celula = screen.getByText('12 − 4 vendido').parentElement as HTMLElement;
    expect(celula.getAttribute('title')).toContain('− 4 vendido em pedido aberto no Omie (ainda sem NF');
  });
});

describe('ItensTable — múltiplo da embalagem do portal (litro → balde)', () => {
  it('motor arredondou (fator 0,2): badge "8 emb. do fornecedor" e NÃO "mínimo forçado"', () => {
    setup({ linhas: [linha({ qtde_sugerida: 36, qtde_final: 40, fator_embalagem_portal: 0.2, ajustado_humano: null, modo_promocao: null })] });
    expect(screen.getByText('8 emb. do fornecedor')).toBeTruthy();
    expect(screen.queryByText('mínimo forçado')).toBeNull();
  });
  it('sem fator (null): final > sugerida segue atribuído ao mínimo forçado (regressão)', () => {
    setup({ linhas: [linha({ qtde_sugerida: 36, qtde_final: 40, fator_embalagem_portal: null, ajustado_humano: null, modo_promocao: null })] });
    expect(screen.getByText('mínimo forçado')).toBeTruthy();
    expect(screen.queryByText(/emb\. do fornecedor/)).toBeNull();
  });
  it('quantidade editada depois (37 L × 0,2): mostra 7.4 — não esconde que deixou de ser múltiplo', () => {
    setup({ linhas: [linha({ qtde_sugerida: 36, qtde_final: 37, fator_embalagem_portal: 0.2, ajustado_humano: true })] });
    expect(screen.getByText('7.4 emb. do fornecedor')).toBeTruthy();
  });
});

describe('ItensTable — seleção em massa', () => {
  it('editável: 1 checkbox por linha + selecionar-todos no cabeçalho', () => {
    setup({ linhas: [linha({ id: 1 }), linha({ id: 2, sku_codigo_omie: '556' })] });
    // 2 linhas + 1 cabeçalho
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('toggle de linha chama onToggleSelecionado com o id; cabeçalho chama onToggleTodos', () => {
    const props = setup({ linhas: [linha({ id: 7 })] });
    fireEvent.click(screen.getByLabelText('Selecionar item 555'));
    expect(props.onToggleSelecionado).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByLabelText('Selecionar todos os itens'));
    expect(props.onToggleTodos).toHaveBeenCalledTimes(1);
  });

  it('linha selecionada renderiza checkbox marcado', () => {
    setup({ linhas: [linha({ id: 7 })], selecionados: new Set([7]) });
    expect(screen.getByLabelText('Selecionar item 555').getAttribute('aria-checked')).toBe('true');
  });

  it('sem permissão de edição: nenhum checkbox', () => {
    setup({ podeEditar: false });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
