import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestionsList } from '../SuggestionsList';
import { type AISuggestion, type Product } from '../types';
import { fmt } from '../helpers';

const catalog: Product[] = [
  { id: 'p1', codigo: 'C1', descricao: 'Disco', valor_unitario: 25, estoque: 5, account: 'oben' },
];

const suggestions: AISuggestion[] = [
  { type: 'product', product_id: 'p1', descricao: 'Disco', reason: 'Comprado com frequência', quantity: 1, account: 'oben' },
];

// Nascimento (getProductPrice) ≠ tabela (25): discrimina "preço que o carrinho grava" de "tabela".
const precoNascimentoPorId = (id: string): number | null => (id === 'p1' ? 18.5 : null);

describe('SuggestionsList', () => {
  it('mostra contagem, motivo e o item', () => {
    render(
      <SuggestionsList
        suggestions={suggestions}
        catalog={catalog}
        userTools={[]}
        hasCustomerSelected
        onAccept={() => {}}
        precoNascimentoPorId={precoNascimentoPorId}
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
        precoNascimentoPorId={precoNascimentoPorId}
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
        precoNascimentoPorId={precoNascimentoPorId}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    expect(onAccept).toHaveBeenCalledWith(suggestions[0]);
  });

  it('exibe o preço de NASCIMENTO — não a tabela nem um unit_price da edge velha nem o selo "Preço cliente"', () => {
    const daEdgeVelha = [{ ...suggestions[0], unit_price: 999 }] as unknown as AISuggestion[];
    render(
      <SuggestionsList
        suggestions={daEdgeVelha}
        catalog={catalog}
        userTools={[]}
        hasCustomerSelected
        onAccept={() => {}}
        precoNascimentoPorId={precoNascimentoPorId}
      />,
    );
    expect(screen.getByText(`${fmt(18.5)}/un`)).toBeTruthy();
    expect(screen.queryByText(`${fmt(25)}/un`)).toBeNull();
    expect(screen.queryByText(`${fmt(999)}/un`)).toBeNull();
    expect(screen.queryByText('Preço cliente')).toBeNull();
  });

  it('preço de partida não firme: Adicionar BLOQUEADO e sem número (mesmo gate do ADD da lista)', () => {
    const onAccept = vi.fn();
    render(
      <SuggestionsList
        suggestions={suggestions}
        catalog={catalog}
        userTools={[]}
        hasCustomerSelected
        onAccept={onAccept}
        precoNascimentoPorId={precoNascimentoPorId}
        precoLoading
      />,
    );
    const btn = screen.getByRole('button', { name: /Adicionar/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.queryByText(/\/un/)).toBeNull();
  });
});
