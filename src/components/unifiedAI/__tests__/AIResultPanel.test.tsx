import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIResultPanel } from '../AIResultPanel';
import { type AIProduct, type AICustomerMatch } from '../types';

const customer: AICustomerMatch = {
  nome_fantasia: 'Cliente X',
  razao_social: 'Cliente X SA',
  cnpj_cpf: '00.000.000/0001-00',
  codigo_cliente: 1,
  confidence: 'high',
};

const oneProduct: AIProduct[] = [
  { product_id: 'p1', codigo: 'C1', descricao: 'Disco', quantity: 2, account: 'oben' },
];

function base(overrides: Partial<React.ComponentProps<typeof AIResultPanel>> = {}) {
  const props: React.ComponentProps<typeof AIResultPanel> = {
    aiMessage: 'Encontrei 1 produto(s) e 0 serviço(s).',
    aiFallbackActive: false,
    onClear: vi.fn(),
    onAnalyze: vi.fn(),
    isAnalyzing: false,
    identifiedCustomer: null,
    hasCustomerSelected: false,
    onConfirmCustomer: vi.fn(),
    identifiedProducts: [],
    catalog: [],
    onRemoveProduct: vi.fn(),
    identifiedServices: [],
    userTools: [],
    isLoading: false,
    onConfirmItems: vi.fn(),
    suggestions: [],
    onAcceptSuggestion: vi.fn(),
    ...overrides,
  };
  render(<AIResultPanel {...props} />);
  return props;
}

describe('AIResultPanel', () => {
  it('mostra a mensagem da IA', () => {
    base();
    expect(screen.getByText('Resultado da IA')).toBeTruthy();
    expect(screen.getByText('Encontrei 1 produto(s) e 0 serviço(s).')).toBeTruthy();
  });

  it('mostra "Tentar novamente" no fallback e dispara onAnalyze', () => {
    const props = base({ aiFallbackActive: true });
    const btn = screen.getByRole('button', { name: /Tentar novamente/ });
    fireEvent.click(btn);
    expect(props.onAnalyze).toHaveBeenCalledTimes(1);
  });

  it('mostra card de cliente apenas quando identificado e sem cliente selecionado', () => {
    base({ identifiedCustomer: customer, hasCustomerSelected: false });
    expect(screen.getByText('Cliente Identificado')).toBeTruthy();
  });

  it('NÃO mostra card de cliente quando já há cliente selecionado', () => {
    base({ identifiedCustomer: customer, hasCustomerSelected: true });
    expect(screen.queryByText('Cliente Identificado')).toBeNull();
  });

  it('mostra botão de confirmar itens quando há itens e cliente selecionado', () => {
    const props = base({ identifiedProducts: oneProduct, hasCustomerSelected: true });
    const btn = screen.getByRole('button', { name: /Adicionar 1 item\(ns\) ao Pedido/ });
    fireEvent.click(btn);
    expect(props.onConfirmItems).toHaveBeenCalledTimes(1);
  });

  it('mostra aviso "Selecione o cliente primeiro" quando há itens sem cliente nem identificação', () => {
    base({ identifiedProducts: oneProduct, hasCustomerSelected: false, identifiedCustomer: null });
    expect(screen.getByText(/Selecione o cliente primeiro/)).toBeTruthy();
  });

  it('mostra aviso "Clique em Selecionar" quando há itens e cliente identificado mas não selecionado', () => {
    base({ identifiedProducts: oneProduct, hasCustomerSelected: false, identifiedCustomer: customer });
    expect(screen.getByText(/Clique em "Selecionar" no cliente acima/)).toBeTruthy();
  });
});
