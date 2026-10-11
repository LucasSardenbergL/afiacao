// Fase 1 do pedido com cor (2026-10-11): teclado contínuo no seletor e "Tentar de
// novo" que também refaz o preço. O que estes testes travam é o FAIL-CLOSED do
// atalho: Enter nunca adiciona quando o botão não estaria habilitado.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormulaResult } from '../types';

/* ─── Mocks do hook do diálogo e do preço ─── */
const hookState: { current: Record<string, unknown> } = { current: {} };
vi.mock('../useTintColorSelect', async (importOriginal) => {
  const real = await importOriginal<typeof import('../useTintColorSelect')>();
  return {
    ...real,
    useTintColorSelect: (...args: Parameters<typeof real.useTintColorSelect>) =>
      hookState.current.__real ? real.useTintColorSelect(...args) : hookState.current,
  };
});

const refetchPricing = vi.fn();
const refetchAltPrices = vi.fn();
const pricingState = { isError: true, isFetching: false };
vi.mock('@/hooks/useTintPricing', () => ({
  useTintPricing: (id: string | null) => ({
    data: undefined,
    isLoading: false,
    isError: !!id && pricingState.isError,
    isFetching: pricingState.isFetching,
    refetch: refetchPricing,
  }),
  // Erro DEPOIS de um sucesso: o React Query mantém o último mapa bom em `data`.
  useTintPrices: () => ({
    data: { 'f-velha': { precoFinal: 999, custoCorantes: 1 } },
    isLoading: false, isError: true, isFetching: false, refetch: refetchAltPrices,
  }),
}));

// Supabase encadeável que sempre responde vazio (as consultas de catálogo não importam aqui).
vi.mock('@/integrations/supabase/client', () => {
  const vazio = { data: null, error: null };
  const cadeia: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? (ok: (v: unknown) => void) => ok(vazio) : () => cadeia),
    apply: () => cadeia,
  });
  return { supabase: cadeia };
});
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { TintColorSelectDialog } from '../../TintColorSelectDialog';
import { SelectedFormulaCard } from '../SelectedFormulaCard';
import { useTintColorSelect } from '../useTintColorSelect';

// Tipo pelas props do diálogo — importar de vendas seria aresta nova tintometrico→vendas.
type Product = React.ComponentProps<typeof TintColorSelectDialog>['product'];

const produto: Product = {
  id: 'prod-base-1', codigo: 'BASE', descricao: 'Base Incolor', unidade: 'GL', valor_unitario: 80,
  estoque: 10, ativo: true, omie_codigo_produto: 9001, account: 'oben', is_tintometric: true, tint_type: 'base',
};
const formulas: FormulaResult[] = [
  { id: 'f1', cor_id: 'RAL9010', nome_cor: 'Branco Puro', preco_final_sayersystem: 120 },
  { id: 'f2', cor_id: 'RAL5005', nome_cor: 'Azul Sinal', preco_final_sayersystem: 140 },
];

function estadoBase(over: Record<string, unknown> = {}) {
  return {
    search: 'ral', buscaEstavel: true, onSearchChange: vi.fn(), loadingSku: false, skuId: 'sku-1',
    formulas, loadingFormulas: false, colorNotFoundInBase: false, globalColorMatches: [], globalColorExists: false,
    loadingGlobalColors: false, selectedFormula: null, setSelectedFormula: vi.fn(), lastPracticedPrice: null,
    loadingLastPrice: false, alternatives: [], loadingAlternatives: false, altPriceMap: {}, altPriceLoading: false,
    altPriceError: false, falhaLeitura: false, skuError: false, tentarDeNovo: vi.fn(), discountPct: 0,
    setDiscountPct: vi.fn(), altDiscounts: {}, setAltDiscounts: vi.fn(), syncDiscount: false, setSyncDiscount: vi.fn(),
    priceSource: 'calculado', setPriceSourceOverride: vi.fn(), altPriceSourceOverrides: {},
    setAltPriceSourceOverride: vi.fn(), precoCsv: 0, precoCalc: 100, precoCliente: null, custoCorantes: 5,
    precoSemDesconto: 100, precoFinal: 100, disponivel: true, precoCarregando: false, recalculado: false,
    precoImportadoAnterior: null, motivoSemPreco: null,
    ...over,
  };
}

function abrir(over: Record<string, unknown> = {}) {
  hookState.current = estadoBase(over);
  const onConfirm = vi.fn();
  render(<TintColorSelectDialog product={produto} open onClose={vi.fn()} onConfirm={onConfirm} />);
  return { onConfirm, busca: screen.getByPlaceholderText(/Buscar por código/), estado: hookState.current };
}

beforeEach(() => {
  refetchPricing.mockClear();
  refetchAltPrices.mockClear();
  pricingState.isError = true;
  pricingState.isFetching = false;
});

describe('Seletor de cor — teclado a partir da busca', () => {
  it('↓ realça o 2º resultado e Enter o seleciona', () => {
    const { busca, estado } = abrir();
    fireEvent.keyDown(busca, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Azul Sinal/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(estado.setSelectedFormula).toHaveBeenCalledWith(formulas[1]);
  });

  it('↑ não passa do 1º; Enter sem mexer seleciona o 1º', () => {
    const { busca, estado } = abrir();
    fireEvent.keyDown(busca, { key: 'ArrowUp' });
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(estado.setSelectedFormula).toHaveBeenCalledWith(formulas[0]);
  });

  it('Enter antes do debounce assentar NÃO seleciona resultado da busca anterior', () => {
    const { busca, estado } = abrir({ buscaEstavel: false });
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(estado.setSelectedFormula).not.toHaveBeenCalled();
  });

  it('com a cor selecionada e preço disponível, Enter adiciona ao pedido', () => {
    const { busca, onConfirm } = abrir({ selectedFormula: formulas[0] });
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('f1', 'RAL9010', 'Branco Puro', 100, 5,
      { source: 'calculado', discountPct: 0, precoSemDesconto: 100 }, undefined);
  });

  it('Enter com preço CARREGANDO não adiciona', () => {
    const { busca, onConfirm } = abrir({
      selectedFormula: formulas[0], precoCarregando: true, precoFinal: null, precoSemDesconto: null, disponivel: false,
    });
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Enter com preço INDISPONÍVEL não adiciona', () => {
    const { busca, onConfirm } = abrir({
      selectedFormula: formulas[0], precoFinal: null, precoSemDesconto: null, disponivel: false, motivoSemPreco: 'indisponivel',
    });
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('sem preço por motor indisponível, o card oferece "Tentar de novo"', () => {
    const { estado } = abrir({
      selectedFormula: formulas[0], precoFinal: null, precoSemDesconto: null, disponivel: false, motivoSemPreco: 'indisponivel',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(estado.tentarDeNovo).toHaveBeenCalled();
  });
});

describe('SelectedFormulaCard — Enter no desconto e adicionarRef', () => {
  function card(over: Partial<React.ComponentProps<typeof SelectedFormulaCard>> = {}) {
    const ref = createRef<(() => boolean) | null>() as React.MutableRefObject<(() => boolean) | null>;
    const onConfirm = vi.fn();
    render(
      <SelectedFormulaCard
        selectedFormula={formulas[0]} loadingLastPrice={false} lastPracticedPrice={null} precoCsv={0}
        precoCalc={100} precoCliente={null} priceSource="calculado" setPriceSourceOverride={vi.fn()}
        altPriceSourceOverrides={{}} setAltPriceSourceOverride={vi.fn()} precoFinal={90} precoSemDesconto={100}
        disponivel precoCarregando={false} recalculado={false} precoImportadoAnterior={null} motivoSemPreco={null}
        discountPct={10} setDiscountPct={vi.fn()} syncDiscount={false} setSyncDiscount={vi.fn()}
        alternatives={[]} loadingAlternatives={false} altPriceMap={{}} altPriceLoading={false} altDiscounts={{}}
        setAltDiscounts={vi.fn()} custoCorantes={5} onConfirm={onConfirm} adicionarRef={ref}
        {...over}
      />,
    );
    return { ref, onConfirm };
  }

  it('Enter no campo de desconto adiciona com o desconto declarado', () => {
    const { onConfirm } = card();
    fireEvent.keyDown(screen.getByPlaceholderText('0'), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('f1', 'RAL9010', 'Branco Puro', 90, 5,
      { source: 'calculado', discountPct: 10, precoSemDesconto: 100 });
  });

  it('desconto que zera o preço (R$ 0,00) não adiciona por Enter nem por clique — Codex P2', () => {
    const { ref, onConfirm } = card({ discountPct: 99.99, precoFinal: 0 });
    fireEvent.keyDown(screen.getByPlaceholderText('0'), { key: 'Enter' });
    const botao = screen.getByRole('button', { name: /Adicionar ao Pedido/ }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(botao);
    let ok: boolean | undefined;
    act(() => { ok = ref.current?.(); });
    expect(ok).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    // o campo de desconto continua na tela para a vendedora corrigir
    expect(screen.getByPlaceholderText('0')).toBeTruthy();
  });

  it('alternativa com desconto que zera o preço fica desabilitada', () => {
    const alt = {
      formulaId: 'fa', skuId: 's2', omieProductId: 'p2', productDescricao: 'Base QT', productCodigo: 'QT',
      precoFinalCsv: null, product: produto, sameAcabamento: true,
    };
    const { onConfirm } = card({
      alternatives: [alt], altPriceMap: { fa: { precoFinal: 40, custoCorantes: 1 } as never },
      syncDiscount: true, discountPct: 99.99, precoFinal: 0,
    });
    const botaoAlt = screen.getByText('Base QT').closest('button') as HTMLButtonElement;
    expect(botaoAlt.disabled).toBe(true);
    fireEvent.click(botaoAlt);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('adicionarRef devolve false e não confirma quando o preço está carregando', () => {
    const { ref, onConfirm } = card({ precoCarregando: true, precoFinal: null, precoSemDesconto: null, disponivel: false });
    let ok: boolean | undefined;
    act(() => { ok = ref.current?.(); });
    expect(ok).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('useTintColorSelect.tentarDeNovo — também refaz o preço', () => {
  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it('motor falhou → refaz get_tint_price e o batch, mantendo a cor selecionada', () => {
    hookState.current = { __real: true };
    const { result } = renderHook(() => useTintColorSelect({ product: produto, open: true }), { wrapper });
    act(() => { result.current.setSelectedFormula(formulas[1]); });
    expect(result.current.motivoSemPreco).toBe('indisponivel');

    act(() => { result.current.tentarDeNovo(); });

    expect(refetchPricing).toHaveBeenCalledTimes(1);
    expect(refetchAltPrices).toHaveBeenCalledTimes(1);
    expect(result.current.selectedFormula?.id).toBe('f2');
  });

  it('batch em erro NÃO expõe o mapa antigo (alternativa não confirma preço obsoleto — Codex P1)', () => {
    hookState.current = { __real: true };
    const { result } = renderHook(() => useTintColorSelect({ product: produto, open: true }), { wrapper });
    act(() => { result.current.setSelectedFormula(formulas[1]); });
    expect(result.current.altPriceError).toBe(true);
    expect(result.current.altPriceMap).toBeUndefined();
  });

  it('refazendo após erro conta como "calculando" (segura o Adicionar, não pisca "sem preço")', () => {
    hookState.current = { __real: true };
    pricingState.isFetching = true;
    const { result } = renderHook(() => useTintColorSelect({ product: produto, open: true }), { wrapper });
    act(() => { result.current.setSelectedFormula(formulas[1]); });
    expect(result.current.precoCarregando).toBe(true);
    expect(result.current.disponivel).toBe(false);
    expect(result.current.motivoSemPreco).toBeNull();
  });
});
