import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CartSummaryBar } from '../CartSummaryBar';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';
import type { EstadoFormasUI } from '@/services/orderSubmission/formasDegradacao';

function prod(account: 'oben' | 'colacor'): ProductCartItem {
  return {
    type: 'product', account, quantity: 1, unit_price: 10,
    product: { id: 'p', omie_codigo_produto: 'X', codigo: 'C', descricao: 'Lixa', unidade: 'UN' },
  } as unknown as ProductCartItem;
}

const OK: EstadoFormasUI = { degradado: false, motivo: null, erro: false, condicoesAusentes: [] };
const DEGRADADO: EstadoFormasUI = {
  degradado: true, motivo: 'Omie: rate limit', erro: false, condicoesAusentes: [],
};
const DEGRADADO_COM_PROVA: EstadoFormasUI = {
  degradado: true, motivo: 'Omie: rate limit', erro: false, condicoesAusentes: ['A17'],
};

function makeProps(over: Partial<Record<string, unknown>> = {}) {
  return {
    cart: { length: 1 },
    obenProductItems: [prod('oben')],
    colacorProductItems: [] as ProductCartItem[],
    serviceItems: [],
    totalEstimated: 100,
    submitting: false,
    vendedorDivergencias: [] as string[],
    sortedFormasPagamentoOben: [{ codigo: '999', descricao: 'A Vista' }],
    sortedFormasPagamentoColacor: [],
    selectedParcelaOben: '999',
    setSelectedParcelaOben: vi.fn(),
    selectedParcelaColacor: '999',
    setSelectedParcelaColacor: vi.fn(),
    loadingFormas: false,
    customerParcelaRankingOben: [] as string[],
    customerParcelaRankingColacor: [] as string[],
    notes: '',
    setNotes: vi.fn(),
    volumesOben: 1,
    volumesColacor: 0,
    onSubmit: vi.fn(),
    onSubmitQuote: vi.fn(),
    ...over,
  };
}

const botaoEnviar = () => screen.getByRole('button', { name: /enviar pedido/i }) as HTMLButtonElement;

describe('CartSummaryBar — degradação das condições de pagamento chega à tela', () => {
  it('sem degradação → nenhum aviso, envio liberado', () => {
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: OK })} />);
    expect(screen.queryByText(/condições do omie indisponíveis/i)).toBeNull();
    expect(botaoEnviar().disabled).toBe(false);
  });

  // COMPATIBILIDADE (item 3): edge antiga não manda `degraded` → o hook produz o default.
  it('props de estado AUSENTES (edge antiga) → nenhum aviso falso, envio liberado', () => {
    render(<CartSummaryBar {...makeProps()} />);
    expect(screen.queryByText(/condições do omie indisponíveis/i)).toBeNull();
    expect(botaoEnviar().disabled).toBe(false);
  });

  it('degradado SEM prova → aviso visível com motivo, mas envio segue liberado', () => {
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: DEGRADADO })} />);
    expect(screen.getByText(/condições do omie indisponíveis/i)).toBeTruthy();
    expect(screen.getByText(/rate limit/i)).toBeTruthy();
    expect(botaoEnviar().disabled).toBe(false);
  });

  it('degradado COM prova (cliente usa condição ausente) → envio BLOQUEADO e o código citado', () => {
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: DEGRADADO_COM_PROVA })} />);
    expect(botaoEnviar().disabled).toBe(true);
    expect(screen.getAllByText(/A17/).length).toBeGreaterThan(0);
  });

  it('bloqueio NÃO trava o orçamento — é a saída do vendedor (não grava codigo_parcela)', () => {
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: DEGRADADO_COM_PROVA })} />);
    const orcamento = screen.getByRole('button', { name: /orçamento/i }) as HTMLButtonElement;
    expect(orcamento.disabled).toBe(false);
  });

  it('degradação de conta SEM item no carrinho não bloqueia (a condição dela não é enviada)', () => {
    render(<CartSummaryBar {...makeProps({
      obenProductItems: [prod('oben')],
      colacorProductItems: [],
      estadoFormasOben: OK,
      estadoFormasColacor: DEGRADADO_COM_PROVA,
    })} />);
    expect(botaoEnviar().disabled).toBe(false);
  });

  it('a MESMA degradação na conta COM item bloqueia — o par que prova o detector', () => {
    render(<CartSummaryBar {...makeProps({
      obenProductItems: [],
      colacorProductItems: [prod('colacor')],
      estadoFormasOben: OK,
      estadoFormasColacor: DEGRADADO_COM_PROVA,
    })} />);
    expect(botaoEnviar().disabled).toBe(true);
  });

  it('falha total da consulta → aviso de indisponível, sem inventar bloqueio', () => {
    const erro: EstadoFormasUI = { degradado: false, motivo: null, erro: true, condicoesAusentes: [] };
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: erro })} />);
    expect(screen.getByText(/não foi possível carregar as condições/i)).toBeTruthy();
    expect(botaoEnviar().disabled).toBe(false);
  });

  it('oferece "Tentar de novo" quando há como recarregar', () => {
    const onRecarregarFormas = vi.fn();
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: DEGRADADO, onRecarregarFormas })} />);
    expect(screen.getByRole('button', { name: /tentar de novo/i })).toBeTruthy();
  });

  it('durante o loading não mostra aviso (estado ainda indefinido, não degradado)', () => {
    render(<CartSummaryBar {...makeProps({ estadoFormasOben: DEGRADADO, loadingFormas: true })} />);
    expect(screen.queryByText(/condições do omie indisponíveis/i)).toBeNull();
  });
});
