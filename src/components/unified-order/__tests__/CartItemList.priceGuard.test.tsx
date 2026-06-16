import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Evita carregar o grafo pesado de useUnifiedOrder (supabase/react-query/contexts):
// CartItemList só precisa de fmt/getToolName em runtime.
vi.mock('@/hooks/useUnifiedOrder', () => ({
  fmt: (v: number) => `R$ ${v}`,
  getToolName: () => 'Ferramenta',
}));
vi.mock('@/hooks/usePrecoCockpit', () => ({
  usePrecoCockpit: () => ({ data: undefined }),
  chaveCockpit: (e: string, c: number, t: string | null) => `${e}|${c}|${t ?? ''}`,
}));

import { CartItemList } from '../CartItemList';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';

function prod(unit_price: number): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 1, unit_price,
    product: { id: 'p', omie_codigo_produto: 1, codigo: 'C', descricao: 'Lixa', unidade: 'UN' },
  } as unknown as ProductCartItem;
}

function makeProps(obenProductItems: ProductCartItem[]) {
  return {
    cart: { length: obenProductItems.length },
    obenProductItems,
    colacorProductItems: [] as ProductCartItem[],
    serviceItems: [],
    obenSubtotal: 0,
    colacorProdSubtotal: 0,
    serviceSubtotal: 0,
    totalEstimated: 0,
    deliveryOption: 'balcao' as const,
    selectedTimeSlot: '',
    onUpdateQuantity: vi.fn(),
    onUpdateProductPrice: vi.fn(),
    onRemoveFromCart: vi.fn(),
    getServicePrice: () => null,
    getCartIndex: () => 0,
  };
}

describe('CartItemList — destaque de preço ≤ 0', () => {
  it('produto com preço 0 → input de preço marcado aria-invalid', () => {
    const { container } = render(<CartItemList {...makeProps([prod(0)])} />);
    expect(container.querySelectorAll('[aria-invalid="true"]').length).toBe(1);
  });

  it('produto com preço positivo → nenhum input marcado inválido', () => {
    const { container } = render(<CartItemList {...makeProps([prod(10)])} />);
    expect(container.querySelectorAll('[aria-invalid="true"]').length).toBe(0);
  });
});
