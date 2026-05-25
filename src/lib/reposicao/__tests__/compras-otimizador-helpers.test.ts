import { describe, it, expect } from 'vitest';
import { qtdMinimaEfetiva, qtdBase, descontoAplicavel, gerarCandidatos } from '../compras-otimizador-helpers';

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
