import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GlobalColorMatches } from '../GlobalColorMatches';
import type { AlternativePackaging } from '../types';
import type { Product } from '@/hooks/useUnifiedOrder';

const product = { id: 'p1', descricao: 'Base Branca 900ml', valor_unitario: 50 } as unknown as Product;

function alt(partial: Partial<AlternativePackaging>): AlternativePackaging {
  return {
    formulaId: 'f1',
    skuId: 's1',
    omieProductId: 'op1',
    productDescricao: 'Base Branca 3.6L',
    productCodigo: 'WFOB36',
    precoFinalCsv: 200,
    product: { id: 'op1', valor_unitario: 180 } as unknown as Product,
    sameAcabamento: false,
    corId: 'RAL9010',
    nomeCor: 'Branco',
    ...partial,
  };
}

describe('GlobalColorMatches', () => {
  it('mostra mensagem vazia quando não há matches nem a cor existe', () => {
    render(<GlobalColorMatches product={product} matches={[]} onConfirm={() => {}} />);
    expect(screen.getByText('Nenhuma cor encontrada em nenhuma base.')).toBeTruthy();
  });

  it('mensagem honesta: cor existe mas sem embalagem vendável (colorExists)', () => {
    render(<GlobalColorMatches product={product} matches={[]} colorExists onConfirm={() => {}} />);
    expect(screen.getByText('Esta cor existe, mas não há embalagem vendável para esta base')).toBeTruthy();
    // nunca afirma ausência quando a cor está no catálogo
    expect(screen.queryByText('Nenhuma cor encontrada em nenhuma base.')).toBeNull();
  });

  it('colorExists=false mantém "nenhuma cor encontrada"', () => {
    render(<GlobalColorMatches product={product} matches={[]} colorExists={false} onConfirm={() => {}} />);
    expect(screen.getByText('Nenhuma cor encontrada em nenhuma base.')).toBeTruthy();
  });

  it('mostra aviso e lista de embalagens alternativas', () => {
    render(<GlobalColorMatches product={product} matches={[alt({})]} onConfirm={() => {}} />);
    expect(screen.getByText('Esta cor não pode ser feita nesta base')).toBeTruthy();
    expect(screen.getByText('Base Branca 3.6L')).toBeTruthy();
  });

  it('confirma com preço CSV quando presente', () => {
    const onConfirm = vi.fn();
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: 200 })]} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Base Branca 3.6L'));
    expect(onConfirm).toHaveBeenCalledWith('f1', 'RAL9010', 'Branco', 200, 0, expect.objectContaining({ id: 'op1' }));
  });

  it('usa valor_unitario da base quando não há preço CSV', () => {
    const onConfirm = vi.fn();
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: null })]} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Base Branca 3.6L'));
    expect(onConfirm).toHaveBeenCalledWith('f1', 'RAL9010', 'Branco', 180, 0, expect.objectContaining({ id: 'op1' }));
  });
});
