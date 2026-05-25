import { describe, it, expect } from 'vitest';
import { qtdMinimaEfetiva, qtdBase, descontoAplicavel, gerarCandidatos } from '../compras-otimizador-helpers';
import { capitalExtra, aumentoEvitadoRs, impactoPrazoRs, freteIncrementalRs, descontoIncrementalRs } from '../compras-otimizador-helpers';

describe('qtdMinimaEfetiva', () => {
  it('max(lote, forçado)', () => {
    expect(qtdMinimaEfetiva(50, 120)).toBe(120);
    expect(qtdMinimaEfetiva(50, null)).toBe(50);
    expect(qtdMinimaEfetiva(null, null)).toBe(0);
  });
});

describe('qtdBase', () => {
  it('= max(qtde_base operacional, mínimo efetivo)', () => {
    expect(qtdBase({ qtde_base: 100, lote_minimo_fornecedor: 50, minimo_forcado_manual: null })).toBe(100);
    expect(qtdBase({ qtde_base: 100, lote_minimo_fornecedor: 50, minimo_forcado_manual: 200 })).toBe(200);
    expect(qtdBase({ qtde_base: 30, lote_minimo_fornecedor: 50, minimo_forcado_manual: null })).toBe(50);
  });
});

describe('descontoAplicavel — melhor faixa cujo volume_minimo ≤ q', () => {
  const curva = [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }];
  it('q abaixo de tudo → 0', () => { expect(descontoAplicavel(curva, 50)).toBe(0); });
  it('q na 1ª faixa → 5', () => { expect(descontoAplicavel(curva, 150)).toBe(5); });
  it('q na 2ª faixa → 8 (melhor)', () => { expect(descontoAplicavel(curva, 400)).toBe(8); });
});

describe('gerarCandidatos — q_base + thresholds + limites de aumento/ruptura, arredondados ao lote', () => {
  it('inclui q_base e os volume_minimo ≥ q_base', () => {
    const c = gerarCandidatos({
      q_base: 100, lote: 50, demanda_diaria: 10,
      curva: [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }],
      dias_ate_aumento: null, ruptura_dias: null,
    });
    expect(c).toContain(100);
    expect(c).toContain(300);
    expect(c.every((q) => q >= 100)).toBe(true);
  });
  it('inclui o limite do aumento (demanda × dias_ate_aumento) arredondado ao lote', () => {
    const c = gerarCandidatos({ q_base: 100, lote: 50, demanda_diaria: 10, curva: [], dias_ate_aumento: 30, ruptura_dias: null });
    expect(c).toContain(300); // 10×30 = 300 ≥ q_base
  });
});

describe('capitalExtra — extra carrega desde o dia 0 (cobertura do q_base + ½ da própria)', () => {
  it('fórmula = valor_extra × cm × ((q_base/d) + 0,5×(q_extra/d))/365', () => {
    // valor_extra=10000, cm=0.365, d=10, q_base=100 (10 dias), q_extra=50 (5 dias)
    // dias efetivos = 10 + 0,5×5 = 12,5 → 10000×0,365×12,5/365 = 125
    const r = capitalExtra({ valor_extra: 10000, cm_anual: 0.365, demanda_diaria: 10, q_base: 100, q_extra: 50 });
    expect(r).toBeCloseTo(125, 2);
  });
  it('demanda 0/null → 0 (não dá pra dimensionar tempo)', () => {
    expect(capitalExtra({ valor_extra: 10000, cm_anual: 0.2, demanda_diaria: null, q_base: 100, q_extra: 50 })).toBe(0);
  });
});

describe('aumentoEvitadoRs — só a qtd consumida APÓS a vigência', () => {
  it('qtd elegível = max(0, q_cand − max(q_base, demanda×dias_ate_aumento))', () => {
    // q_base 100, demanda 10, dias_ate_aumento 30 → consumo até vigência = 300; q_cand 400 → elegível 100
    // aumento 10%, preço 50 → 100×50×0,10 = 500
    const r = aumentoEvitadoRs({ q_cand: 400, q_base: 100, demanda_diaria: 10, dias_ate_aumento: 30, aumento_perc: 10, preco_unit: 50 });
    expect(r).toBeCloseTo(500, 2);
  });
  it('sem aumento/dias → 0', () => {
    expect(aumentoEvitadoRs({ q_cand: 400, q_base: 100, demanda_diaria: 10, dias_ate_aumento: null, aumento_perc: null, preco_unit: 50 })).toBe(0);
  });
});

describe('impactoPrazoRs — (prazo_cand% − prazo_padrão%) × valor_candidato; +encargo=custo', () => {
  it('encargo maior que o padrão → custo positivo (a subtrair)', () => {
    const r = impactoPrazoRs({ prazo_cand_perc: 3, prazo_padrao_perc: 1, valor_candidato: 20000 });
    expect(r).toBeCloseTo(400, 2); // delta 2% × 20000
  });
});

describe('freteIncrementalRs — % valor + fixo + taxa de pedido sobre o incremento', () => {
  it('soma as 3 formas sobre o valor extra', () => {
    const r = freteIncrementalRs({ valor_extra: 10000, frete_perc_valor: 2, frete_fixo: 0, frete_taxa_pedido: 0 });
    expect(r).toBeCloseTo(200, 2);
  });
});

describe('descontoIncrementalRs — desc(q_cand) − desc(q_base), campo atômico', () => {
  it('= q_cand×preço×desc%(q_cand) − q_base×preço×desc%(q_base)', () => {
    const curva = [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }];
    // q_base 100 (5%): 100×50×0,05=250; q_cand 300 (8%): 300×50×0,08=1200 → incremental 950
    const r = descontoIncrementalRs({ curva, q_cand: 300, q_base: 100, preco_unit: 50 });
    expect(r).toBeCloseTo(950, 2);
  });
});
