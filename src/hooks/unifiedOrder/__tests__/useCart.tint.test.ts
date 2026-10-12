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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
import { toast } from 'sonner';

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

// Fase 2A: o 1 toque das "Cores do cliente" entra SEM diálogo pendente — traz a própria
// qtd (a da compra repetida) e a decisão de preço que o gate revalida.
describe('useCart — 1 toque (qtd explícita, sem diálogo pendente)', () => {
  it('qtd explícita vence a pendente e o item carrega fonte/desconto/preço-base', () => {
    const { result } = setup();
    act(() => {
      result.current.addTintProductToCart(
        baseTint, 'f-1', '346J', 'PLATINA BIANCO', 150.1, 3,
        { source: 'tabela', discountPct: 0, precoSemDesconto: 150.1 }, 4,
      );
    });
    expect(result.current.productItems[0]).toMatchObject({
      quantity: 4, unit_price: 150.1, tint_formula_id: 'f-1',
      tint_price_source: 'tabela', tint_discount_pct: 0, tint_preco_sem_desconto: 150.1,
    });
  });

  it('qtd explícita inválida (0/NaN) cai na pendente (1), nunca item com 0', () => {
    const { result } = setup();
    act(() => {
      result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 10, 0, undefined, 0);
    });
    act(() => {
      result.current.addTintProductToCart(baseTint, 'f-2', '347J', 'Y', 10, 0, undefined, Number.NaN);
    });
    expect(result.current.productItems.map((i) => i.quantity)).toEqual([1, 1]);
  });
});

// Codex P1 (Fase 2A): somar por fórmula fazia a unidade NOVA herdar o desconto antigo.
describe('useCart — mesma fórmula só consolida com a MESMA decisão de preço', () => {
  const comDesconto = { source: 'calculado', discountPct: 50, precoSemDesconto: 100 };
  const semDesconto = { source: 'calculado', discountPct: 0, precoSemDesconto: 100 };

  it('decisão diferente (1 toque sem desconto sobre item com 50%) → RECUSA com aviso, carrinho intacto', () => {
    const { result } = setup();
    act(() => { result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 50, 0, comDesconto, 1); });
    act(() => { result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 100, 0, semDesconto, 4); });
    // nem soma (herdaria o desconto) nem 2ª linha (chave duplicada no carrinho — Codex rodada 2)
    expect(result.current.productItems.map((i) => [i.quantity, i.unit_price, i.tint_discount_pct])).toEqual([[1, 50, 50]]);
    expect(vi.mocked(toast.warning)).toHaveBeenCalled();
  });

  it('sem metadados de preço, preço diferente da mesma fórmula → recusa (não funde preços)', () => {
    // Sem fonte/desconto declarados, o PREÇO é a única marca da decisão (o gate barra o item
    // sem lastro; aqui o que se trava é o carrinho não fundir preços diferentes).
    const { result } = setup();
    act(() => { result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 50, 0, undefined, 1); });
    act(() => { result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 100, 0, undefined, 1); });
    expect(result.current.productItems.map((i) => [i.unit_price, i.quantity])).toEqual([[50, 1]]);
  });

  it('mesma decisão → soma a quantidade na linha existente (comportamento da Fase 1)', () => {
    const { result } = setup();
    act(() => { result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 50, 0, comDesconto, 1); });
    act(() => { result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 50, 0, comDesconto, 2); });
    expect(result.current.productItems.map((i) => i.quantity)).toEqual([3]);
  });
});

// Codex P1 (rodada 3): a recusa NÃO pode parecer sucesso — o resultado volta ao chamador e a
// pendência (base + qtd do diálogo / fila do "Repetir pedido") fica intacta.
describe('useCart — conflito devolve resultado e preserva a pendência', () => {
  const a = { source: 'calculado', discountPct: 50, precoSemDesconto: 100 };
  const b = { source: 'calculado', discountPct: 0, precoSemDesconto: 100 };

  it('conflito → "conflito", base e qtd pendentes continuam; sucesso → "adicionado" e limpa', () => {
    const { result } = setup();
    let r1 = '';
    act(() => { r1 = result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 50, 0, a, 1); });
    expect(r1).toBe('adicionado');
    act(() => { result.current.setTintPendingProduct(baseTint, 4); });
    let r2 = '';
    act(() => { r2 = result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 100, 0, b); });
    expect(r2).toBe('conflito');
    expect(result.current.tintPendingProduct?.id).toBe('prod-base-1');
    expect(result.current.productItems.map((i) => i.quantity)).toEqual([1]);
  });

  it('2 decisões diferentes no MESMO batch: a 2ª é conflito COM aviso, nunca descarte calado', () => {
    const { result } = setup();
    vi.mocked(toast.warning).mockClear();
    const rs: string[] = [];
    act(() => {
      rs.push(result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 50, 0, a, 1));
      rs.push(result.current.addTintProductToCart(baseTint, 'f-1', '346J', 'X', 100, 0, b, 1));
    });
    expect(rs).toEqual(['adicionado', 'conflito']);
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1);
    expect(result.current.productItems.map((i) => i.unit_price)).toEqual([50]);
  });
});
