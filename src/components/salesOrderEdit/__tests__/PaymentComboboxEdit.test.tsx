import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentComboboxEdit } from '../PaymentComboboxEdit';

const formas = [
  { codigo: '000', descricao: 'À vista' },
  { codigo: '030', descricao: '30 dias' },
];

describe('PaymentComboboxEdit', () => {
  it('mostra placeholder quando nada selecionado', () => {
    render(<PaymentComboboxEdit formas={formas} selected="" onSelect={vi.fn()} />);
    expect(screen.getByText('Selecionar parcela')).toBeTruthy();
  });

  it('mostra a descrição da forma selecionada', () => {
    render(<PaymentComboboxEdit formas={formas} selected="030" onSelect={vi.fn()} />);
    expect(screen.getByText('30 dias')).toBeTruthy();
  });

  it('respeita o disabled', () => {
    render(<PaymentComboboxEdit formas={formas} selected="" onSelect={vi.fn()} disabled />);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });
});
