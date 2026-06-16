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
