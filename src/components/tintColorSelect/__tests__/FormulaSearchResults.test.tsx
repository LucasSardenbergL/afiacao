import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormulaSearchResults } from '../FormulaSearchResults';
import type { FormulaResult } from '../types';

const formulas: FormulaResult[] = [
  { id: 'f1', cor_id: 'RAL9010', nome_cor: 'Branco Puro', preco_final_sayersystem: 120 },
  { id: 'f2', cor_id: 'RAL5005', nome_cor: 'Azul Sinal', preco_final_sayersystem: 140 },
];

describe('FormulaSearchResults', () => {
  it('renderiza cada fórmula com cor_id e nome', () => {
    render(<FormulaSearchResults formulas={formulas} onSelect={() => {}} />);
    expect(screen.getByText('RAL9010')).toBeTruthy();
    expect(screen.getByText('Branco Puro')).toBeTruthy();
    expect(screen.getByText('RAL5005')).toBeTruthy();
  });

  it('dispara onSelect com a fórmula clicada', () => {
    const onSelect = vi.fn();
    render(<FormulaSearchResults formulas={formulas} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Azul Sinal'));
    expect(onSelect).toHaveBeenCalledWith(formulas[1]);
  });
});
