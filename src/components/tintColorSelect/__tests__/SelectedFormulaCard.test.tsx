import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectedFormulaCard } from '../SelectedFormulaCard';
import type { FormulaResult, AlternativePackaging } from '../types';
import type { Product } from '@/hooks/useUnifiedOrder';

const selectedFormula: FormulaResult = { id: 'f1', cor_id: 'RAL5005', nome_cor: 'Azul Sinal', preco_final_sayersystem: 50 };

function setup(overrides: Partial<React.ComponentProps<typeof SelectedFormulaCard>> = {}) {
  const props: React.ComponentProps<typeof SelectedFormulaCard> = {
    selectedFormula,
    loadingLastPrice: false,
    lastPracticedPrice: null,
    precoCsv: 50,
    priceSource: 'tabela',
    setPriceSourceOverride: vi.fn(),
    precoFinal: 50,
    precoSemDesconto: 50,
    discountPct: 0,
    setDiscountPct: vi.fn(),
    syncDiscount: false,
    setSyncDiscount: vi.fn(),
    alternatives: undefined,
    loadingAlternatives: false,
    altDiscounts: {},
    setAltDiscounts: vi.fn(),
    custoCorantes: 5,
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<SelectedFormulaCard {...props} />);
  return props;
}

describe('SelectedFormulaCard', () => {
  it('renderiza cor e nome da fórmula selecionada', () => {
    setup();
    expect(screen.getByText('RAL5005')).toBeTruthy();
    expect(screen.getByText('Azul Sinal')).toBeTruthy();
  });

  it('confirma com os dados da fórmula e preço final', () => {
    const props = setup({ precoFinal: 50, custoCorantes: 5 });
    fireEvent.click(screen.getByRole('button', { name: /Adicionar ao Pedido/ }));
    expect(props.onConfirm).toHaveBeenCalledWith('f1', 'RAL5005', 'Azul Sinal', 50, 5);
  });

  it('clampa o desconto entre 0 e 100', () => {
    const props = setup();
    const input = screen.getByPlaceholderText('0') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '150' } });
    expect(props.setDiscountPct).toHaveBeenCalledWith(100);
  });

  it('mostra seletor de preço quando há último preço cliente e tabela; dispara override', () => {
    const props = setup({ lastPracticedPrice: { price: 40, date: '2026-05-01T00:00:00Z' }, precoCsv: 50, priceSource: 'cliente' });
    fireEvent.click(screen.getByRole('button', { name: /Tabela/ }));
    expect(props.setPriceSourceOverride).toHaveBeenCalledWith('tabela');
  });

  it('lista embalagens alternativas e confirma com o produto alternativo', () => {
    const altProduct = { id: 'op2', valor_unitario: 80 } as unknown as Product;
    const alternatives: AlternativePackaging[] = [
      {
        formulaId: 'fa', skuId: 's2', omieProductId: 'op2',
        productDescricao: 'Base 3.6L', productCodigo: 'B36', precoFinalCsv: 200,
        product: altProduct, sameAcabamento: false,
      },
    ];
    const props = setup({ alternatives });
    expect(screen.getByText('Mesma cor em outras embalagens')).toBeTruthy();
    fireEvent.click(screen.getByText('Base 3.6L'));
    expect(props.onConfirm).toHaveBeenCalledWith('fa', 'RAL5005', 'Azul Sinal', 200, 5, altProduct);
  });
});
