import { describe, it, expect } from 'vitest';
import {
  baseDoCodigo,
  montarTermosBusca,
  normalizeProductCode,
  refinarCandidatos,
} from '../code-normalize';

describe('normalizeProductCode', () => {
  it('uppercases, trims e remove espaços internos, preserva pontos/sufixo', () => {
    expect(normalizeProductCode('  fo20.6827.00 ')).toBe('FO20.6827.00');
    expect(normalizeProductCode('TEH 3505.211FG')).toBe('TEH3505.211FG');
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

describe('baseDoCodigo', () => {
  it('remove o sufixo de embalagem (QT/GL/FG) mas mantém o número da fórmula', () => {
    expect(baseDoCodigo('FO20.6827.00GL')).toBe('FO20.6827.00');
    expect(baseDoCodigo('WFOT.6529QT')).toBe('WFOT.6529');
    expect(baseDoCodigo('FO20.6827.00')).toBe('FO20.6827.00'); // já é base (sem sufixo de letra)
  });
});

describe('montarTermosBusca', () => {
  it('inclui o código, a base e o miolo numérico estável', () => {
    const termos = montarTermosBusca('FO20.6827.00');
    expect(termos).toContain('FO20.6827.00');
    expect(termos).toContain('6827');
  });
  it('código sem miolo numérico → só o código', () => {
    expect(montarTermosBusca('ABC')).toEqual(['ABC']);
  });
});

describe('refinarCandidatos (match por BASE da fórmula — 1 boletim → N embalagens)', () => {
  const cand = (omie_codigo_produto: number, descricao: string, account = 'oben') =>
    ({ account, omie_codigo_produto, codigo: 'PRD', descricao });

  it('boletim (base) casa a embalagem (mesma base, sufixo colado) na descrição', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(1, 'VERNIZ PU FO20.6827.00GL')]);
    expect(r).toHaveLength(1);
    expect(r[0].match).toBe('exato');
    expect(r[0].ambiguo).toBe(false);
  });
  it('NÃO casa fórmula diferente (o número distinto é preservado na base)', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(2, 'VERNIZ PU FO20.6828.00GL')]);
    expect(r[0].match).toBe('fraco');
  });
  it('catalisador citado SEM embalagem não é extraído → não polui nem cria ambiguidade', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(3, 'VERNIZ FO20.6827.00GL c/ FC.6952')]);
    expect(r[0].match).toBe('exato');
    expect(r[0].ambiguo).toBe(false);
  });
  it('descrição com 2 fórmulas DISTINTAS embaladas → ambíguo (triagem humana)', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(4, 'KIT FO20.6827.00GL WP12.3900QT')]);
    expect(r[0].ambiguo).toBe(true);
  });
  it('casa a variante separador-espaço do tingidor (extrator normaliza espaço→ponto)', () => {
    const r = refinarCandidatos('TEH.3505.211FG', [cand(5, 'TINGIDOR TEH 3505.211FG')]);
    expect(r[0].match).toBe('exato');
  });
});
