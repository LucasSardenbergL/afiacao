import { describe, it, expect } from 'vitest';
import { resolverCustoConfiavel, estimarCustoParaRanking, derivarMargensCandidato, type CostRow } from '../cost-source';

const row = (o: Partial<CostRow>): CostRow => ({ cost_price: null, cost_final: null, cost_source: null, cost_confidence: null, ...o });

describe('resolverCustoConfiavel', () => {
  it('PRODUCT_COST com cost_final>0 → cost_final', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: 12.5 }))).toBe(12.5);
  });
  it('CMC com cost_final>0 → cost_final', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 8 }))).toBe(8);
  });
  it('CMC com cost_final=0 mas cost_price>0 → cost_price (os 14 do syncInventory)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 0, cost_price: 9.9 }))).toBe(9.9);
  });
  it('PRODUCT_COST com cost_final inválido NÃO cai p/ cost_price → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: 0, cost_price: 9.9 }))).toBeNull();
  });
  it('FAMILY_MARGIN_PROXY → null (não fabrica margem)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 50 }))).toBeNull();
  });
  it('DEFAULT_PROXY → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'DEFAULT_PROXY', cost_final: 50 }))).toBeNull();
  });
  it('UNKNOWN / source null / row null → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'UNKNOWN', cost_final: 50 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: null, cost_final: 50 }))).toBeNull();
    expect(resolverCustoConfiavel(null)).toBeNull();
    expect(resolverCustoConfiavel(undefined)).toBeNull();
  });
  it('falsificação: cost_final negativo/NaN/Infinity → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: -5 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: NaN }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: Infinity }))).toBeNull();
  });
  it('falsificação CMC: cost_final E cost_price inválidos → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 0, cost_price: 0 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: NaN, cost_price: -1 }))).toBeNull();
  });
  it('normaliza espaço/caixa do backfill', () => {
    expect(resolverCustoConfiavel(row({ cost_source: '  product_cost  ', cost_final: 7 }))).toBe(7);
  });
});

describe('estimarCustoParaRanking', () => {
  it('custo real presente → custo real', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'PRODUCT_COST', cost_final: 30 }), 100)).toBe(30);
  });
  it('sem real, proxy cost_final válido (<price) → proxy cost_final', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 60 }), 100)).toBe(60);
    expect(estimarCustoParaRanking(row({ cost_source: 'DEFAULT_PROXY', cost_final: 75 }), 100)).toBe(75);
  });
  it('proxy cost_final ≥ price (margem estimada ≤0) → null', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'DEFAULT_PROXY', cost_final: 120 }), 100)).toBeNull();
  });
  it('UNKNOWN / sem row / proxy sem cost_final → null', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'UNKNOWN', cost_final: 50 }), 100)).toBeNull();
    expect(estimarCustoParaRanking(null, 100)).toBeNull();
    expect(estimarCustoParaRanking(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: null }), 100)).toBeNull();
  });
});

describe('derivarMargensCandidato', () => {
  it('custo real → exibida e ranking iguais (margem real)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'PRODUCT_COST', cost_final: 30 }), 100))
      .toEqual({ custoConfiavel: 30, custoRanking: 30, margemExibida: 70, margemRanking: 70 });
  });
  it('proxy → exibida null, ranking via estimativa (não fabrica margem exibida)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 60 }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: 60, margemExibida: null, margemRanking: 40 });
  });
  it('UNKNOWN/sem sinal → tudo null (EIP será neutralizado pelo motor)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'UNKNOWN' }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: null, margemExibida: null, margemRanking: null });
  });
});
