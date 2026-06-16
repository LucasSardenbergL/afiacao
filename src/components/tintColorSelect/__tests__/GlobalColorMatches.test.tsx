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

  it('CSV presente mas sem cálculo no mapa (batch não respondeu) → sem preço, não confirma (fail-closed)', () => {
    const onConfirm = vi.fn();
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: 200 })]} onConfirm={onConfirm} />);
    expect(screen.getByText(/sem pre[çc]o/i)).toBeTruthy();
    fireEvent.click(screen.getByText('Base Branca 3.6L'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('batch carregando (precoLoading) → mostra "calculando", não "sem preço"', () => {
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: 200 })]} precoLoading onConfirm={() => {}} />);
    expect(screen.getByText(/calculando/i)).toBeTruthy();
    expect(screen.queryByText(/sem pre[çc]o/i)).toBeNull();
  });

  it('usa o preço calculado do mapa quando disponível (base + corantes)', () => {
    const onConfirm = vi.fn();
    const precoMap = { f1: { custoBase: 152.1, baseDisponivel: true, custoCorantes: 18.06, corantesCompletos: true, precoFinal: 170.16 } };
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: 13.7 })]} precoMap={precoMap} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Base Branca 3.6L'));
    expect(onConfirm).toHaveBeenCalledWith('f1', 'RAL9010', 'Branco', 170.2, 18.06, expect.objectContaining({ id: 'op1' }));
  });

  it('sem CSV e sem cálculo → "sem preço", não confirma (não vende a valor_unitario nu)', () => {
    const onConfirm = vi.fn();
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: null })]} onConfirm={onConfirm} />);
    expect(screen.getByText(/sem pre[çc]o/i)).toBeTruthy();
    fireEvent.click(screen.getByText('Base Branca 3.6L'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('base sem preço no mapa (PRD03657) → "sem preço", não confirma mesmo com CSV', () => {
    const onConfirm = vi.fn();
    const precoMap = { f1: { custoBase: null, baseDisponivel: false, custoCorantes: 0, corantesCompletos: true, precoFinal: null } };
    render(<GlobalColorMatches product={product} matches={[alt({ precoFinalCsv: 101.7 })]} precoMap={precoMap} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Base Branca 3.6L'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
