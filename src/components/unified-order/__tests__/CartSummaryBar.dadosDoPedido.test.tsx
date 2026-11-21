import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CartSummaryBar } from '../CartSummaryBar';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';

// Rodada 2, PR B: B1 (Observações sem campo) e B3 (dia de entrega no passado).
function prod(): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 1, unit_price: 10,
    product: { id: 'p', omie_codigo_produto: 'X', codigo: 'C', descricao: 'Lixa', unidade: 'UN' },
  } as unknown as ProductCartItem;
}

function makeProps(over: Record<string, unknown> = {}) {
  return {
    cart: { length: 1 },
    obenProductItems: [prod()],
    colacorProductItems: [] as ProductCartItem[],
    serviceItems: [],
    totalEstimated: 10,
    submitting: false,
    vendedorDivergencias: [] as string[],
    sortedFormasPagamentoOben: [],
    sortedFormasPagamentoColacor: [],
    selectedParcelaOben: '1',
    setSelectedParcelaOben: vi.fn(),
    selectedParcelaColacor: '1',
    setSelectedParcelaColacor: vi.fn(),
    loadingFormas: false,
    customerParcelaRankingOben: [],
    customerParcelaRankingColacor: [],
    notes: '',
    setNotes: vi.fn(),
    volumesOben: 1,
    volumesColacor: 0,
    onSubmit: vi.fn(),
    readyByDate: '',
    setReadyByDate: vi.fn(),
    ...over,
  };
}

afterEach(() => vi.useRealTimers());

describe('CartSummaryBar — dados do pedido', () => {
  it('B1: há um campo "Observações do pedido" rotulado e ele escreve em setNotes', () => {
    const setNotes = vi.fn();
    render(<CartSummaryBar {...makeProps({ notes: 'portão', setNotes })} />);
    const campo = screen.getByLabelText('Observações do pedido') as HTMLTextAreaElement;
    expect(campo.value).toBe('portão');
    fireEvent.change(campo, { target: { value: 'portão dos fundos' } });
    expect(setNotes).toHaveBeenCalledWith('portão dos fundos');
  });

  it('B3: numa quinta, nenhum dia já passado é oferecido; o escolhido tem aria-pressed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 19, 10, 0)); // quinta 19/11/2026
    render(<CartSummaryBar {...makeProps({ readyByDate: '2026-11-20' })} />);
    const grupo = screen.getByRole('group', { name: /dia de entrega/i });
    const botoes = Array.from(grupo.querySelectorAll('button'));
    expect(botoes).toHaveLength(5);
    expect(botoes.some(b => /segunda 16\/11|terça 17\/11|quarta 18\/11/i.test(b.textContent ?? ''))).toBe(false);
    expect(botoes[0].textContent).toMatch(/hoje/i);
    const sexta = botoes.find(b => /20\/11/.test(b.textContent ?? ''));
    expect(sexta?.getAttribute('aria-pressed')).toBe('true');
    expect(botoes[0].getAttribute('aria-pressed')).toBe('false');
  });
});
