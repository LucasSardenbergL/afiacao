import { describe, it, expect } from 'vitest';
import { iofCredito, custoEmReais, custoAntecipacao, custoOportunidadeCaixa } from '../funding-helpers';

describe('iofCredito', () => {
  it('aplica 0,38% fixo + 0,0082%/dia', () => {
    // 30 dias: 0,0038 + 0,000082*30 = 0,0038 + 0,00246 = 0,00626
    expect(iofCredito(1000, 30)).toBeCloseTo(1000 * 0.00626, 4);
  });
  it('limita a parcela diária a 365 dias', () => {
    expect(iofCredito(1000, 999)).toBeCloseTo(iofCredito(1000, 365), 6);
  });
  it('zero pra dias<=0', () => { expect(iofCredito(1000, 0)).toBe(1000 * 0.0038); });
});

describe('custoEmReais', () => {
  it('M*((1+r)^(D/365)-1)', () => {
    expect(custoEmReais(10000, 365, 0.20)).toBeCloseTo(2000, 2); // 1 ano a 20%
    expect(custoEmReais(10000, 30, 0.20)).toBeCloseTo(10000 * (Math.pow(1.2, 30/365) - 1), 4);
  });
  it('zero em inputs não-positivos', () => {
    expect(custoEmReais(0, 30, 0.2)).toBe(0);
    expect(custoEmReais(1000, 0, 0.2)).toBe(0);
    expect(custoEmReais(1000, 30, 0)).toBe(0);
  });
});

describe('custoAntecipacao', () => {
  it('desconto: deságio por fora + IOF + tarifa; custo_rs = V - v_liq', () => {
    const r = custoAntecipacao({ valor: 10000, dias: 30, taxa_desconto_mensal: 0.022, tipo: 'desconto', tarifa_fixa: 5 });
    const desagio = 10000 * 0.022 * (30/30); // 220
    const iof = 10000 * 0.00626;             // 62,6
    expect(r.desagio).toBeCloseTo(desagio, 4);
    expect(r.iof).toBeCloseTo(iof, 4);
    expect(r.v_liq).toBeCloseTo(10000 - desagio - iof - 5, 4);
    expect(r.custo_rs).toBeCloseTo(10000 - r.v_liq, 6);
    expect(r.taxa_efetiva_aa).toBeCloseTo(Math.pow(10000 / r.v_liq, 365/30) - 1, 6);
  });
  it('factoring: IOF zero', () => {
    const r = custoAntecipacao({ valor: 10000, dias: 30, taxa_desconto_mensal: 0.03, tipo: 'factoring' });
    expect(r.iof).toBe(0);
  });
  it('v_liq<=0 → taxa_efetiva null', () => {
    const r = custoAntecipacao({ valor: 100, dias: 30, taxa_desconto_mensal: 2, tipo: 'desconto' });
    expect(r.taxa_efetiva_aa).toBeNull();
  });
});

describe('custoOportunidadeCaixa', () => {
  it('ocioso → cm_anual', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: 0.4, ha_fila_a4_positiva: false, caixa_suficiente: true })).toBe(0.18);
  });
  it('fila A4 positiva + caixa insuficiente → max(cm, retorno A4)', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: 0.40, ha_fila_a4_positiva: true, caixa_suficiente: false })).toBe(0.40);
  });
  it('sem retorno A4 informado → cm_anual', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: null, ha_fila_a4_positiva: true, caixa_suficiente: false })).toBe(0.18);
  });
});
