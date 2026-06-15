import { describe, it, expect } from 'vitest';
import { classificarFaixa, markupSobreCmc, type FaixaInput } from './cockpit-preco';

const base = (o: Partial<FaixaInput>): FaixaInput => ({
  preco: 100, cmc: 60, pisoMarkup: 30, metaMarkup: 50, temCusto: true, temPolitica: true, ...o,
});

describe('classificarFaixa', () => {
  it('sem custo → neutro/sem_custo', () => {
    expect(classificarFaixa(base({ temCusto: false, cmc: null }))).toEqual({ faixa: 'neutro', motivo: 'sem_custo' });
  });
  it('preço abaixo do custo → vermelho (mesmo sem política)', () => {
    expect(classificarFaixa(base({ preco: 50, cmc: 60, temPolitica: false }))).toEqual({ faixa: 'vermelho', motivo: 'abaixo_do_custo' });
  });
  it('acima do custo mas sem política → neutro/sem_politica (NUNCA verde)', () => {
    expect(classificarFaixa(base({ preco: 100, cmc: 60, temPolitica: false }))).toEqual({ faixa: 'neutro', motivo: 'sem_politica' });
  });
  it('abaixo do piso → amarelo', () => {
    // piso = 60*(1.30)=78; preço 70 < 78
    expect(classificarFaixa(base({ preco: 70 }))).toEqual({ faixa: 'amarelo', motivo: 'abaixo_do_piso' });
  });
  it('entre piso e meta → verde/abaixo_da_meta', () => {
    // piso=78, meta=60*1.5=90; preço 85
    expect(classificarFaixa(base({ preco: 85 }))).toEqual({ faixa: 'verde', motivo: 'abaixo_da_meta' });
  });
  it('na/acima da meta → verde/saudavel', () => {
    expect(classificarFaixa(base({ preco: 95 }))).toEqual({ faixa: 'verde', motivo: 'saudavel' });
  });
  it('preço exatamente no piso → verde (≥ piso)', () => {
    expect(classificarFaixa(base({ preco: 78 }))).toEqual({ faixa: 'verde', motivo: 'abaixo_da_meta' });
  });
  it('preço inválido (NaN) → neutro, NUNCA verde (#7)', () => {
    expect(classificarFaixa(base({ preco: NaN }))).toEqual({ faixa: 'neutro', motivo: 'sem_custo' });
  });
  it('cmc inválido (NaN) com custo declarado → neutro (#7)', () => {
    expect(classificarFaixa(base({ cmc: NaN }))).toEqual({ faixa: 'neutro', motivo: 'sem_custo' });
  });
});

describe('markupSobreCmc', () => {
  it('null quando cmc inválido', () => {
    expect(markupSobreCmc(100, null)).toBeNull();
    expect(markupSobreCmc(100, 0)).toBeNull();
  });
  it('markup% e folga R$ sobre CMC', () => {
    expect(markupSobreCmc(100, 60)).toEqual({ markupPerc: ((100 - 60) / 60) * 100, folgaReais: 40 });
  });
});
