import { describe, it, expect } from 'vitest';
import { classificarCR, classificarCP, calcularACO, calcularPCO, calcularPME, calcularCCC } from '../ncg-helpers';

describe('classificarCR', () => {
  it('aberto sempre conta pra ACO', () => {
    expect(classificarCR({ saldo: 100, status_titulo: 'ABERTO' })).toBe('aco_cr_aberto');
  });
  it('liquidado não conta', () => {
    expect(classificarCR({ saldo: 0, status_titulo: 'LIQUIDADO' })).toBe('nenhum');
  });
});

describe('classificarCP', () => {
  it('categoria adiantamento classifica como ACO', () => {
    expect(classificarCP(
      { saldo: 500, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' },
      ['2.01.01']
    )).toBe('aco_adiantamento');
  });
  it('categoria de imposto (3.99) classifica como PCO tributos', () => {
    expect(classificarCP(
      { saldo: 1000, status_titulo: 'ABERTO', categoria_codigo: '3.99.01' },
      []
    )).toBe('pco_tributos');
  });
  it('aberto comum vai pra PCO fornecedor', () => {
    expect(classificarCP(
      { saldo: 200, status_titulo: 'ABERTO', categoria_codigo: '3.01.01' },
      []
    )).toBe('pco_cp_fornecedor');
  });
});

describe('calcularACO', () => {
  it('soma CR aberto + estoque + adiantamentos', () => {
    const aco = calcularACO({
      crs: [
        { saldo: 1000, status_titulo: 'ABERTO' },
        { saldo: 500, status_titulo: 'ABERTO' },
      ],
      cps: [
        { saldo: 300, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' },
      ],
      adiantamento_categorias_codigos: ['2.01.01'],
      estoque_valor: 2000,
    });
    expect(aco.cr_aberto).toBe(1500);
    expect(aco.estoque).toBe(2000);
    expect(aco.adiantamentos).toBe(300);
    expect(aco.total).toBe(3800);
  });
});

describe('calcularPCO', () => {
  it('cp_fornecedor exclui tributos (3.99) e adiantamentos; tributos somados à parte', () => {
    const pco = calcularPCO({
      cps: [
        { saldo: 1000, status_titulo: 'ABERTO', categoria_codigo: '3.01.01' }, // fornecedor
        { saldo: 200, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' },  // adiantamento (não conta)
        { saldo: 8000, status_titulo: 'ABERTO', categoria_codigo: '3.99.05' }, // tributo
      ],
      adiantamento_categorias_codigos: ['2.01.01'],
      folha_30d: 50000,
    });
    expect(pco.cp_fornecedor).toBe(1000);
    expect(pco.tributos_a_pagar).toBe(8000);
    expect(pco.folha_30d).toBe(50000);
    expect(pco.total).toBe(59000);
  });
});

describe('calcularPME', () => {
  it('PME = estoque/CMV * 365', () => {
    expect(calcularPME({ estoque_valor: 30000, cmv_ttm: 365000 })).toBeCloseTo(30, 5);
  });
  it('CMV zero ou ausente → PME 0 (serviços)', () => {
    expect(calcularPME({ estoque_valor: 0, cmv_ttm: 0 })).toBe(0);
    expect(calcularPME({ estoque_valor: 5000, cmv_ttm: 0 })).toBe(0);
  });
});

describe('calcularCCC', () => {
  it('CCC = PMR + PME - PMP', () => {
    expect(calcularCCC({ pmr: 40, pme: 30, pmp: 25 })).toBe(45);
  });
  it('sem estoque vira PMR - PMP', () => {
    expect(calcularCCC({ pmr: 40, pme: 0, pmp: 25 })).toBe(15);
  });
});
