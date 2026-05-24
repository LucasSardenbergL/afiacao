import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestionsList } from '../SuggestionsList';
import { type AISuggestion, type Product } from '../types';

const catalog: Product[] = [
  { id: 'p1', codigo: 'C1', descricao: 'Disco', valor_unitario: 25, estoque: 5, account: 'oben' },
];

const suggestions: AISuggestion[] = [
  { type: 'product', product_id: 'p1', descricao: 'Disco', reason: 'Comprado com frequência', quantity: 1, account: 'oben', unit_price: 20 },
];

describe('SuggestionsList', () => {
  it('mostra contagem, motivo e o item', () => {
    render(
      <SuggestionsList
        suggestions={suggestions}
        catalog={catalog}
        userTools={[]}
        hasCustomerSelected
        onAccept={() => {}}
      />,
    );
    expect(screen.getByText('Sugestões (1)')).toBeTruthy();
    expect(screen.getByText('💡 Comprado com frequência')).toBeTruthy();
    expect(screen.getByText('Disco')).toBeTruthy();
  });

  it('esconde o botão Adicionar quando não há cliente selecionado', () => {
    render(
      <SuggestionsList
        suggestions={suggestions}
        catalog={catalog}
        userTools={[]}
        hasCustomerSelected={false}
        onAccept={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Adicionar/ })).toBeNull();
  });

  it('dispara onAccept com a sugestão quando há cliente', () => {
    const onAccept = vi.fn();
    render(
      <SuggestionsList
        suggestions={suggestions}
        catalog={catalog}
        userTools={[]}
        hasCustomerSelected
        onAccept={onAccept}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    expect(onAccept).toHaveBeenCalledWith(suggestions[0]);
  });
});
