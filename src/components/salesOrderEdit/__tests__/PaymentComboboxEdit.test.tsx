import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentComboboxEdit, rotuloDaCondicao } from '../PaymentComboboxEdit';

const formas = [
  { codigo: '000', descricao: 'À vista' },
  { codigo: '030', descricao: '30 dias' },
];

describe('PaymentComboboxEdit', () => {
  it('mostra placeholder quando nada selecionado', () => {
    render(<PaymentComboboxEdit formas={formas} selected="" onSelect={vi.fn()} listaCompleta />);
    expect(screen.getByText('Selecionar parcela')).toBeTruthy();
  });

  it('mostra a descrição da forma selecionada', () => {
    render(<PaymentComboboxEdit formas={formas} selected="030" onSelect={vi.fn()} listaCompleta />);
    expect(screen.getByText('30 dias')).toBeTruthy();
  });

  it('respeita o disabled', () => {
    render(<PaymentComboboxEdit formas={formas} selected="" onSelect={vi.fn()} disabled listaCompleta />);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });

  // Revisão /sales #29: código fora da lista virava string vazia — o pedido parecia sem condição.
  it('condicao salva fora de uma lista completa: mostra o codigo e que esta indisponivel', () => {
    render(<PaymentComboboxEdit formas={formas} selected="S41" onSelect={vi.fn()} listaCompleta />);
    expect(screen.getByText('S41 (indisponível para nova escolha)')).toBeTruthy();
  });

  it('lista vazia ou incompleta: mostra o codigo e que a lista nao carregou', () => {
    expect(rotuloDaCondicao([], 'S41', false)).toBe('S41 (lista de condições indisponível)');
    expect(rotuloDaCondicao(formas, '030', false)).toBe('30 dias');
    expect(rotuloDaCondicao(formas, '', true)).toBe('Selecionar parcela');
  });
});
