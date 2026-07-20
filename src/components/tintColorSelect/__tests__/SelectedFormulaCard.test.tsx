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
    precoCalc: null,
    precoCliente: null,
    priceSource: 'tabela',
    setPriceSourceOverride: vi.fn(),
    altPriceSourceOverrides: {},
    setAltPriceSourceOverride: vi.fn(),
    precoFinal: 50,
    precoSemDesconto: 50,
    disponivel: true,
    precoCarregando: false,
    recalculado: false,
    precoImportadoAnterior: null,
    motivoSemPreco: null,
    discountPct: 0,
    setDiscountPct: vi.fn(),
    syncDiscount: false,
    setSyncDiscount: vi.fn(),
    alternatives: undefined,
    loadingAlternatives: false,
    altPriceMap: {},
    altPriceLoading: false,
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

  it('confirma com os dados da fórmula, preço final e o meta de precificação (Fase 3)', () => {
    const props = setup({ precoFinal: 50, custoCorantes: 5, priceSource: 'calculado', discountPct: 0, precoSemDesconto: 50 });
    fireEvent.click(screen.getByRole('button', { name: /Adicionar ao Pedido/ }));
    expect(props.onConfirm).toHaveBeenCalledWith(
      'f1', 'RAL5005', 'Azul Sinal', 50, 5,
      { source: 'calculado', discountPct: 0, precoSemDesconto: 50 },
    );
  });

  it('clampa o desconto entre 0 e 99.99 (d=100 zeraria o preço — contrato do gate é d<100)', () => {
    const props = setup();
    const input = screen.getByPlaceholderText('0') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '150' } });
    expect(props.setDiscountPct).toHaveBeenCalledWith(99.99);
  });

  it('mostra seletor de preço quando há último preço cliente e tabela; dispara override', () => {
    const props = setup({ lastPracticedPrice: { price: 40, date: '2026-05-01T00:00:00Z' }, precoCsv: 50, precoCliente: 40, priceSource: 'cliente' });
    fireEvent.click(screen.getByRole('button', { name: /Tabela/ }));
    expect(props.setPriceSourceOverride).toHaveBeenCalledWith('tabela');
  });

  it('lista embalagens alternativas e confirma com o produto alternativo (preço do mapa)', () => {
    const altProduct = { id: 'op2', valor_unitario: 80 } as unknown as Product;
    const alternatives: AlternativePackaging[] = [
      {
        formulaId: 'fa', skuId: 's2', omieProductId: 'op2',
        productDescricao: 'Base 3.6L', productCodigo: 'B36', precoFinalCsv: 200,
        product: altProduct, sameAcabamento: false,
      },
    ];
    const altPriceMap = { fa: { custoBase: 80, baseDisponivel: true, custoCorantes: 120, corantesCompletos: true, precoFinal: 200 } };
    const props = setup({ alternatives, altPriceMap });
    expect(screen.getByText('Mesma cor em outras embalagens')).toBeTruthy();
    fireEvent.click(screen.getByText('Base 3.6L'));
    // calc 200 ≈ CSV 200 → calculado; custoCorantes 120 DA própria alternativa
    expect(props.onConfirm).toHaveBeenCalledWith(
      'fa', 'RAL5005', 'Azul Sinal', 200, 120,
      { source: 'calculado', discountPct: 0, precoSemDesconto: 200 },
      altProduct,
    );
  });

  it('alternativa sem breakdown no mapa (batch não respondeu) → "sem preço", não confirma (fail-closed)', () => {
    const altProduct = { id: 'op2', valor_unitario: 80 } as unknown as Product;
    const alternatives: AlternativePackaging[] = [
      { formulaId: 'fa', skuId: 's2', omieProductId: 'op2', productDescricao: 'Base 3.6L', productCodigo: 'B36', precoFinalCsv: 200, product: altProduct, sameAcabamento: false },
    ];
    const props = setup({ alternatives }); // altPriceMap {} default → sem entrada
    fireEvent.click(screen.getByText('Base 3.6L'));
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('alternativa: usa o preço calculado do mapa e o custoCorantes DA própria fórmula (1b)', () => {
    const altProduct = { id: 'op2', valor_unitario: 152.1 } as unknown as Product;
    const alternatives: AlternativePackaging[] = [
      { formulaId: 'fa', skuId: 's2', omieProductId: 'op2', productDescricao: 'Base 3.6L', productCodigo: 'B36', precoFinalCsv: 13.7, product: altProduct, sameAcabamento: false },
    ];
    const altPriceMap = {
      fa: { custoBase: 152.1, baseDisponivel: true, custoCorantes: 18.06, corantesCompletos: true, precoFinal: 170.16 },
    };
    const props = setup({ alternatives, altPriceMap });
    fireEvent.click(screen.getByText('Base 3.6L'));
    expect(props.onConfirm).toHaveBeenCalledWith(
      'fa', 'RAL5005', 'Azul Sinal', 170.2, 18.06,
      { source: 'calculado', discountPct: 0, precoSemDesconto: 170.2 },
      altProduct,
    );
  });

  it('alternativa sem preço (base ausente no mapa): mostra "sem preço" e não confirma', () => {
    const altProduct = { id: 'op2', valor_unitario: 0 } as unknown as Product;
    const alternatives: AlternativePackaging[] = [
      { formulaId: 'fa', skuId: 's2', omieProductId: 'op2', productDescricao: 'Base 3.6L', productCodigo: 'B36', precoFinalCsv: null, product: altProduct, sameAcabamento: false },
    ];
    const altPriceMap = {
      fa: { custoBase: null, baseDisponivel: false, custoCorantes: 0, corantesCompletos: true, precoFinal: null },
    };
    const props = setup({ alternatives, altPriceMap });
    fireEvent.click(screen.getByText('Base 3.6L'));
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/sem pre[çc]o/i)).toBeTruthy();
  });

  // --- Passo 2: motor honesto no balcão ---

  it('calculando preço (RPC carregando): não mostra preço nem "sem preço", esconde Adicionar', () => {
    setup({ precoCarregando: true, disponivel: false, precoFinal: null, precoSemDesconto: null, priceSource: null });
    expect(screen.getByText(/calculando/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Adicionar ao Pedido/ })).toBeNull();
    expect(screen.queryByText(/sem pre[çc]o/i)).toBeNull(); // não afirma "sem preço" durante o loading
  });

  it('sem preço (base sem preço no Omie): mostra aviso honesto e NÃO renderiza Adicionar', () => {
    setup({ disponivel: false, precoFinal: null, precoSemDesconto: null, priceSource: null, motivoSemPreco: 'base' });
    expect(screen.getByText(/sem pre[çc]o/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Adicionar ao Pedido/ })).toBeNull();
  });

  it('sem preço por corante: explica que falta custo de corante', () => {
    setup({ disponivel: false, precoFinal: null, precoSemDesconto: null, priceSource: null, motivoSemPreco: 'corante' });
    expect(screen.getByText(/corante/i)).toBeTruthy();
  });

  it('preço recalculado (Grupo B): avisa que o importado não incluía a base, com antes e agora', () => {
    setup({
      priceSource: 'calculado', precoCalc: 170.2, precoFinal: 170.2, precoSemDesconto: 170.2,
      recalculado: true, precoImportadoAnterior: 13.7,
    });
    expect(screen.getByText(/recalculad/i)).toBeTruthy();
    expect(screen.getByText(/incluía a base|incluia a base/i)).toBeTruthy();
    expect(screen.getByText(/13,70/)).toBeTruthy();                      // antes (importado) — só no aviso
    expect(screen.getAllByText(/170,20/).length).toBeGreaterThan(0);     // agora (aviso + preço + botão)
  });

  it('oferece a fonte "Calculado" quando há cálculo, e dispara o override', () => {
    const props = setup({
      lastPracticedPrice: { price: 40, date: '2026-05-01T00:00:00Z' }, precoCliente: 40,
      precoCsv: 50, precoCalc: 60, priceSource: 'cliente',
    });
    fireEvent.click(screen.getByRole('button', { name: /Calculado/ }));
    expect(props.setPriceSourceOverride).toHaveBeenCalledWith('calculado');
  });

  it('rótulo da fonte CSV é neutro: "Tabela importada", nunca "versão anterior" (Fase 2b-fix)', () => {
    setup({ lastPracticedPrice: { price: 40, date: '2026-05-01T00:00:00Z' }, precoCliente: 40, precoCsv: 50, priceSource: 'cliente' });
    expect(screen.getByRole('button', { name: /Tabela importada/ })).toBeTruthy();
    expect(screen.queryByText(/versão anterior/i)).toBeNull();
  });

  // --- Fase 2b-fix: escolha de fonte da vendedora nas alternativas ---

  const altComAmbasFontes = () => {
    const altProduct = { id: 'op2', valor_unitario: 152.1 } as unknown as Product;
    const alternatives: AlternativePackaging[] = [
      { formulaId: 'fa', skuId: 's2', omieProductId: 'op2', productDescricao: 'Base 3.6L', productCodigo: 'B36', precoFinalCsv: 13.7, product: altProduct, sameAcabamento: false },
    ];
    const altPriceMap = {
      fa: { custoBase: 152.1, baseDisponivel: true, custoCorantes: 18.06, corantesCompletos: true, precoFinal: 170.16 },
    };
    return { altProduct, alternatives, altPriceMap };
  };

  it('alternativa com calc e CSV → oferece o seletor de fonte; clique registra o override da fórmula', () => {
    const { alternatives, altPriceMap } = altComAmbasFontes();
    const props = setup({ alternatives, altPriceMap });
    fireEvent.click(screen.getByRole('button', { name: /Tabela importada/ }));
    expect(props.setAltPriceSourceOverride).toHaveBeenCalledWith('fa', 'tabela');
  });

  it('alternativa com override "tabela" → confirma com o preço do CSV, não o calculado', () => {
    const { altProduct, alternatives, altPriceMap } = altComAmbasFontes();
    const props = setup({ alternatives, altPriceMap, altPriceSourceOverrides: { fa: 'tabela' } });
    fireEvent.click(screen.getByText('Base 3.6L'));
    expect(props.onConfirm).toHaveBeenCalledWith(
      'fa', 'RAL5005', 'Azul Sinal', 13.7, 18.06, // Fase 3: fonte efetiva do override viaja no meta
      { source: 'tabela', discountPct: 0, precoSemDesconto: 13.7 },
      altProduct,
    );
  });

  it('alternativa com só uma fonte (sem breakdown) → não oferece seletor', () => {
    const { alternatives } = altComAmbasFontes();
    setup({ alternatives }); // altPriceMap {} → fail-closed, nenhuma fonte
    expect(screen.queryByRole('button', { name: /Tabela importada/ })).toBeNull();
  });
});
