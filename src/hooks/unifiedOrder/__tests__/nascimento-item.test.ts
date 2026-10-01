import { describe, it, expect, vi } from 'vitest';
import { nascerItemProduto } from '../nascimento-item';
import type { Product } from '../types';

// MONEY-PATH: o preço de nascimento de um item de produto comum tem UM decisor — o getProductPrice
// (= precoPartida) do wizard. A lista do catálogo e o assistente de IA nascem o item por ESTA função
// (paridade literal; o pin de que as duas vias a chamam mora em src/__tests__/edge-money-path-invariants.test.ts).

const produto = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1', codigo: 'C1', descricao: 'Verniz PU', valor_unitario: 25, estoque: 3,
    ativo: true, omie_codigo_produto: 101, account: 'colacor', ...over,
  }) as Product;

describe('nascerItemProduto — o item nasce pelo decisor de preço, e só por ele', () => {
  it('unit_price = precoNascimento = getPrecoNascimento(produto) — o decisor é chamado 1× com o produto', () => {
    const decisor = vi.fn(() => 18.5);
    const p = produto();
    const item = nascerItemProduto(p, 3, decisor);
    expect(decisor).toHaveBeenCalledTimes(1);
    expect(decisor).toHaveBeenCalledWith(p);
    expect(item).toEqual({
      type: 'product', product: p, quantity: 3, unit_price: 18.5, precoNascimento: 18.5, account: 'colacor',
    });
  });

  it('o preço NÃO é o de tabela quando o decisor diz outro (a tabela 25 não vaza para o item)', () => {
    const item = nascerItemProduto(produto(), 1, () => 18.5);
    expect(item.unit_price).not.toBe(25);
  });

  it('precoNascimento SEMPRE presente — é o que deixa a reprecificação da fronteira corrigir o item não editado', () => {
    const item = nascerItemProduto(produto(), 1, () => 10);
    expect(item.precoNascimento).toBe(item.unit_price);
  });

  it('a conta vem do PRODUTO; produto sem conta nasce em oben (a mesma regra do ADD da lista)', () => {
    expect(nascerItemProduto(produto({ account: 'oben' }), 1, () => 1).account).toBe('oben');
    expect(nascerItemProduto(produto({ account: undefined }), 1, () => 1).account).toBe('oben');
  });

  it('não fabrica nem esconde: o que o decisor devolve é o que o item carrega (≤0 é barrado no submit, não aqui)', () => {
    expect(nascerItemProduto(produto(), 1, () => 0).unit_price).toBe(0);
  });
});
