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
    precoNascimentoPorId: () => null,
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

  it('preço de partida não firme: confirmar PRODUTO fica bloqueado (mesmo gate do ADD da lista)', () => {
    const props = base({ identifiedProducts: oneProduct, hasCustomerSelected: true, precoLoading: true });
    const btn = screen.getByRole('button', { name: /Adicionar 1 item\(ns\) ao Pedido/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(props.onConfirmItems).not.toHaveBeenCalled();
  });

  it('preço de partida não firme NÃO bloqueia confirmar só SERVIÇO (serviço não nasce pelo precoPartida)', () => {
    const props = base({
      identifiedServices: [{ userToolId: 'ut1', omie_codigo_servico: 1, servico_descricao: 'Afiação', quantity: 1 }],
      hasCustomerSelected: true,
      precoLoading: true,
    });
    const btn = screen.getByRole('button', { name: /Adicionar 1 item\(ns\) ao Pedido/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
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

describe('AIResultPanel — IA honesta (PR 3.1)', () => {
  it('mostra o desfecho por item com o motivo, inclusive o que NÃO entrou', () => {
    base({
      aiMessage: 'Resultado: 1 adicionado(s) · 1 não entrou(aram).',
      relatorio: {
        itens: [
          { tipo: 'produto', descricao: 'Disco', desfecho: 'adicionado', quantidade: 2, quantidadeInferida: false },
          { tipo: 'produto', descricao: 'Lixa 80', desfecho: 'descartado', quantidade: 1, quantidadeInferida: true, motivo: 'não está no catálogo carregado nesta tela — busque pelo código' },
        ],
        tintas: [],
      },
    });
    expect(screen.getByText('Não entrou')).toBeTruthy();
    expect(screen.getByText(/não está no catálogo carregado/)).toBeTruthy();
    // Descartado não leva selo de inferida (não há quantidade a conferir no carrinho).
    expect(screen.queryAllByTestId('selo-quantidade-inferida')).toHaveLength(0);
  });

  it('marca a quantidade inferida no produto identificado (ausente = inferida)', () => {
    base({
      hasCustomerSelected: true,
      identifiedProducts: [
        { ...oneProduct[0], quantidade_inferida: false },
        { product_id: 'p2', codigo: 'C2', descricao: 'Lixa', quantity: 1, account: 'oben' },
      ],
    });
    expect(screen.getAllByTestId('selo-quantidade-inferida')).toHaveLength(1);
  });

  it('lista o que a edge descartou, com o motivo', () => {
    base({ descartadosIA: [{ descricao: 'Afiar serra 300', motivo: 'a ferramenta não está no cadastro deste cliente' }] });
    expect(screen.getByText('Afiar serra 300')).toBeTruthy();
    expect(screen.getByText(/não está no cadastro/)).toBeTruthy();
  });
});
