/**
 * @vitest-environment jsdom
 */
// PR 2.4: o preço do produto comum vive em centavos no carrinho (nascimento e edição) e o subtotal
// é a soma das linhas arredondadas — o mesmo total que o Omie e o gate de crédito calculam.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), critical: vi.fn(), warn: vi.fn() } }));

import { useCart } from '../useCart';
import type { Product, ProductCartItem } from '@/hooks/useUnifiedOrder';
import { precoPartida } from '@/lib/pricing/precoPartida';

const produto = (id: string, cod: number, valor: number): Product => ({
  id, codigo: `P-${cod}`, descricao: `Produto ${cod}`, unidade: 'UN', valor_unitario: valor, estoque: 10, ativo: true,
  omie_codigo_produto: cod, account: 'oben',
});

const montar = (getProductPrice: (p: Product) => number) =>
  renderHook(() => useCart({ getProductPrice, getServicePrice: () => null, servicos: [] }));

describe('useCart — centavos', () => {
  it('edição manual (e o "aplicar" da Régua, que usa a mesma via) grava ao centavo', () => {
    const { result } = montar((p) => p.valor_unitario);
    act(() => { result.current.addProductToCart(produto('a', 1, 10), 1); });
    act(() => { result.current.updateProductPrice(0, 12.3456); });
    expect((result.current.cart[0] as ProductCartItem).unit_price).toBe(12.35);
  });

  it('nascimento pelo último praticado de 4 casas já entra ao centavo', () => {
    const viaPartida = (p: Product) =>
      precoPartida({ tabela: p.valor_unitario, ultimoPraticado: 7.1249, ultimoPraticadoEm: null, hoje: new Date(), tier: null, mult: null });
    const { result } = montar(viaPartida);
    act(() => { result.current.addProductToCart(produto('a', 1, 10), 1); });
    const it = result.current.cart[0] as ProductCartItem;
    expect(it.unit_price).toBe(7.12);
    expect(it.precoNascimento).toBe(7.12);
  });

  it('subtotal arredonda POR LINHA antes de somar', () => {
    const { result } = montar((p) => p.valor_unitario);
    act(() => {
      result.current.addProductToCart(produto('a', 1, 0.01), 0.5);
      result.current.addProductToCart(produto('b', 2, 0.01), 0.5);
    });
    // cada linha 0,005 → 0,01; a soma crua daria 0,01
    expect(result.current.obenSubtotal).toBe(0.02);
  });
});
