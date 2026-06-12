import { describe, it, expect } from 'vitest';
import { normalizeProductCode, montarTermosBusca, refinarCandidatos } from '../code-normalize';

describe('normalizeProductCode', () => {
  it('uppercases, trims e remove espaços internos, preserva pontos/sufixo', () => {
    expect(normalizeProductCode('  fo20.6827.00 ')).toBe('FO20.6827.00');
    expect(normalizeProductCode('TEH 3505.211FG')).toBe('TEH3505.211FG'); // espaço removido (NÃO vira ponto aqui)
    expect(normalizeProductCode('fc.6952')).toBe('FC.6952');
  });
  it('mantém GL/QT/LT/.00 (são identidade, não removidos)', () => {
    expect(normalizeProductCode('FO20.6827.00GL')).toBe('FO20.6827.00GL');
  });
  it('vazio/nulo → string vazia', () => {
    expect(normalizeProductCode('')).toBe('');
    expect(normalizeProductCode(null)).toBe('');
    expect(normalizeProductCode(undefined)).toBe('');
  });
});

describe('montarTermosBusca', () => {
  it('inclui o código inteiro e o miolo numérico estável', () => {
    const termos = montarTermosBusca('FO20.6827.00');
    expect(termos).toContain('FO20.6827.00');
    expect(termos).toContain('6827'); // miolo: casa descrição mesmo com separador diferente
  });
  it('código sem miolo numérico → só o código', () => {
    expect(montarTermosBusca('ABC')).toEqual(['ABC']);
  });
});

describe('refinarCandidatos', () => {
  const cand = (omie_codigo_produto: number, descricao: string, account = 'oben') =>
    ({ account, omie_codigo_produto, codigo: 'PRD', descricao });

  it('match exato por token: o código do boletim ∈ códigos da descrição', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(1, 'VERNIZ PU FO20.6827.00 GL')]);
    expect(r).toHaveLength(1);
    expect(r[0].match).toBe('exato');
    expect(r[0].ambiguo).toBe(false);
  });
  it('NÃO casa por substring de outro código (catalisador citado)', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(2, 'CATALISADOR FC.6952 QT')]);
    expect(r.filter((c) => c.match === 'exato')).toHaveLength(0);
  });
  it('descrição com >1 código → marca ambíguo (não auto-confirmável)', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(3, 'KIT FO20.6827.00 + FC.6952 GL')]);
    expect(r[0].ambiguo).toBe(true);
  });
  it('casa a variante separador-espaço (tingidor) via normalização do extrator', () => {
    const r = refinarCandidatos('TEH.3505.211FG', [cand(4, 'TINGIDOR TEH 3505.211FG')]);
    expect(r[0].match).toBe('exato');
  });
});
