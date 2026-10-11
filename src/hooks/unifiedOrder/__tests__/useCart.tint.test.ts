/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): este é um
 * `.ts` — logo, no ambiente `node` por padrão — mas toca DOM. O docblock sobrepõe o
 * project e é local ao arquivo, então não vira ímã de conflito entre worktrees.
 */
// Trava o contrato do item tintométrico no BALCÃO: o item do carrinho carrega
// `tint_formula_id` (a fórmula da cor) além de cor/nome/custo. Já era o
// comportamento correto — este teste é a rede de regressão que mantém o balcão
// em paridade com a edição (useSalesOrderEdit.handleTintConfirm).
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useCart } from '../useCart';
import type { Product } from '@/hooks/useUnifiedOrder';

const baseTint: Product = {
  id: 'prod-base-1',
  codigo: 'BASE-INC',
  descricao: 'Base Incolor Tintométrica',
  unidade: 'GL',
  valor_unitario: 80,
  estoque: 10,
  ativo: true,
  omie_codigo_produto: 9001,
  account: 'oben',
  is_tintometric: true,
  tint_type: 'base',
};

function setup() {
  return renderHook(() =>
    useCart({
      getProductPrice: (p) => p.valor_unitario ?? 0,
      getServicePrice: () => null,
      servicos: [],
    }),
  );
}

describe('useCart.addTintProductToCart', () => {
  it('grava tint_formula_id (e cor/nome/custo) no item de tinta', () => {
    const { result } = setup();

    act(() => {
      result.current.addTintProductToCart(baseTint, 'formula-uuid-123', 'RAL5005', 'Azul Genciana', 120, 7);
    });

    expect(result.current.productItems).toHaveLength(1);
    expect(result.current.productItems[0]).toMatchObject({
      tint_cor_id: 'RAL5005',
      tint_nome_cor: 'Azul Genciana',
      tint_custo_corantes: 7,
      tint_formula_id: 'formula-uuid-123',
    });
  });
});

// Fase 1 do pedido com cor (2026-10-11): a quantidade digitada na lista se perdia no
// caminho da tinta — a base abria o diálogo de cor e o item nascia com 1.
describe('useCart — quantidade da base tintométrica até a confirmação da cor', () => {
  it('adicionar base com qty 3 → confirmar cor → carrinho com 3', () => {
    const { result } = setup();

    act(() => {
      result.current.addProductToCart(baseTint, 3);
    });
    expect(result.current.tintPendingProduct?.id).toBe('prod-base-1');
    expect(result.current.productItems).toHaveLength(0);

    act(() => {
      result.current.addTintProductToCart(baseTint, 'formula-uuid-123', 'RAL5005', 'Azul Genciana', 120, 7);
    });

    expect(result.current.productItems).toHaveLength(1);
    expect(result.current.productItems[0].quantity).toBe(3);
    expect(result.current.tintPendingProduct).toBeNull();
  });

  it('confirmação pela embalagem alternativa também leva a qty', () => {
    const { result } = setup();
    const alt: Product = { ...baseTint, id: 'prod-base-alt', codigo: 'BASE-QT' };

    act(() => {
      result.current.addProductToCart(baseTint, 4);
    });
    act(() => {
      result.current.addTintProductToCart(alt, 'formula-alt', 'RAL5005', 'Azul Genciana', 60, 3);
    });

    expect(result.current.productItems[0]).toMatchObject({ quantity: 4, tint_formula_id: 'formula-alt' });
  });

  it('repetir pedido (setTintPendingProduct com qtd) preserva a qty, e a mesma cor de novo SOMA', () => {
    const { result } = setup();

    act(() => {
      result.current.setTintPendingProduct(baseTint, 5);
    });
    act(() => {
      result.current.addTintProductToCart(baseTint, 'formula-uuid-123', 'RAL5005', 'Azul Genciana', 120, 7);
    });
    act(() => {
      result.current.addProductToCart(baseTint, 2);
    });
    act(() => {
      result.current.addTintProductToCart(baseTint, 'formula-uuid-123', 'RAL5005', 'Azul Genciana', 120, 7);
    });

    expect(result.current.productItems).toHaveLength(1);
    expect(result.current.productItems[0].quantity).toBe(7);
  });

  it('a qty não vaza para a próxima abertura sem qtd (volta a 1)', () => {
    const { result } = setup();

    act(() => {
      result.current.setTintPendingProduct(baseTint, 6);
    });
    act(() => {
      result.current.setTintPendingProduct(null); // cancelou o diálogo
    });
    act(() => {
      result.current.setTintPendingProduct(baseTint); // "Cores do cliente": sem qtd
    });
    act(() => {
      result.current.addTintProductToCart(baseTint, 'formula-uuid-123', 'RAL5005', 'Azul Genciana', 120, 7);
    });

    expect(result.current.productItems[0].quantity).toBe(1);
  });
});
