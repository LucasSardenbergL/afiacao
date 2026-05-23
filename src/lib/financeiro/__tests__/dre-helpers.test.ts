import { describe, it, expect } from 'vitest';
import { classificarLinhaDRE, REGIME_POR_EMPRESA } from '../dre-helpers';

const M = (pairs: Array<[string, string]>) => new Map<string, string>(pairs);

describe('REGIME_POR_EMPRESA', () => {
  it('mapeia as 3 empresas', () => {
    expect(REGIME_POR_EMPRESA.colacor).toBe('presumido');
    expect(REGIME_POR_EMPRESA.oben).toBe('presumido');
    expect(REGIME_POR_EMPRESA.colacor_sc).toBe('simples');
  });
});

describe('classificarLinhaDRE — mapping explícito', () => {
  it('usa dre_linha de imposto do mapping (presumido: ICMS → ded_icms)', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '3.05', categoria_descricao: 'ICMS sobre vendas',
      isReceita: false, regime: 'presumido', mapping: M([['3.05', 'ded_icms']]),
    });
    expect(r.linha).toBe('ded_icms');
    expect(r.mapeado).toBe(true);
    expect(r.viaFallback).toBe(false);
  });

  it('prefix match', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '3.01.02.003', categoria_descricao: 'x',
      isReceita: false, regime: 'presumido', mapping: M([['3.01', 'cmv']]),
    });
    expect(r.linha).toBe('cmv');
    expect(r.mapeado).toBe(true);
  });
});

describe('classificarLinhaDRE — fallback regime-aware de imposto', () => {
  it('presumido: keyword IRPJ não mapeado → irpj + viaFallback', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '9.99', categoria_descricao: 'IRPJ trimestral',
      isReceita: false, regime: 'presumido', mapping: M([]),
    });
    expect(r.linha).toBe('irpj');
    expect(r.mapeado).toBe(false);
    expect(r.viaFallback).toBe(true);
    expect(r.impostoNaoMapeado).toBe(true);
  });

  it('presumido: PIS → ded_pis; COFINS → ded_cofins; ISS → ded_iss; IPI → ded_ipi', () => {
    const reg = 'presumido' as const;
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'PIS', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_pis');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'COFINS', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_cofins');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'ISS retido', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_iss');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'IPI', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_ipi');
  });

  it('SIMPLES: qualquer imposto por keyword → das (linha única, nunca quebra)', () => {
    const reg = 'simples' as const;
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'DAS Simples Nacional', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('das');
    const r = classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'ICMS', isReceita: false, regime: reg, mapping: M([]) });
    expect(r.linha).toBe('das');
    expect(r.impostoNaoMapeado).toBe(true);
  });
});

describe('classificarLinhaDRE — não-imposto', () => {
  it('CMV por keyword', () => {
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'Custo mercadoria vendida', isReceita: false, regime: 'presumido', mapping: M([]) }).linha).toBe('cmv');
  });
  it('receita: devolução → deducoes', () => {
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'Devolução de venda', isReceita: true, regime: 'presumido', mapping: M([]) }).linha).toBe('deducoes');
  });
  it('receita não mapeada → receita_bruta (fallback)', () => {
    const r = classificarLinhaDRE({ categoria_codigo: '1.99', categoria_descricao: 'Venda balcão', isReceita: true, regime: 'presumido', mapping: M([]) });
    expect(r.linha).toBe('receita_bruta');
    expect(r.viaFallback).toBe(true);
  });
});
