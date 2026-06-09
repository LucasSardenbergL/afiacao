import { describe, it, expect } from 'vitest';
import { qtdMinimaEfetiva, qtdBase, aplicarMinimoForcado, quantidadeCompraInteira, descontoAplicavel, prazoAplicavel, gerarCandidatos } from '../compras-otimizador-helpers';
import { capitalExtra, aumentoEvitadoRs, impactoPrazoRs, freteIncrementalRs, descontoIncrementalRs } from '../compras-otimizador-helpers';
import { avaliarComprarMais } from '../compras-otimizador-helpers';
import type { InsumoSku } from '../compras-otimizador-helpers';

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

describe('aplicarMinimoForcado — espelho do GREATEST(natural, COALESCE(min,0)) da RPC', () => {
  it('sem mínimo (null) → não força, retorna o natural', () => {
    expect(aplicarMinimoForcado(10, null)).toBe(10);
    expect(aplicarMinimoForcado(500, null)).toBe(500);
  });
  it('mínimo > natural → eleva ao mínimo', () => {
    expect(aplicarMinimoForcado(10, 200)).toBe(200);
    expect(aplicarMinimoForcado(0, 200)).toBe(200); // helper é só o GREATEST; a ativação é gated pelo filtro qtde_natural>0 na RPC
  });
  it('natural ≥ mínimo → mantém o natural', () => {
    expect(aplicarMinimoForcado(500, 200)).toBe(500);
    expect(aplicarMinimoForcado(200, 200)).toBe(200);
  });
  it('valor inválido (≤0 / NaN / Infinity) → não força (degradação honesta)', () => {
    expect(aplicarMinimoForcado(10, 0)).toBe(10);
    expect(aplicarMinimoForcado(10, -5)).toBe(10);
    expect(aplicarMinimoForcado(10, NaN)).toBe(10);
    expect(aplicarMinimoForcado(10, Infinity)).toBe(10);
  });
  it('natural negativo/inválido não vira número fabricado', () => {
    expect(aplicarMinimoForcado(-5, null)).toBe(-5); // GREATEST puro; a RPC filtra qtde_natural>0 antes
  });
});

describe('descontoAplicavel — melhor faixa cujo volume_minimo ≤ q', () => {
  const curva = [{ volume_minimo: 100, desconto_promo_perc: 5 }, { volume_minimo: 300, desconto_promo_perc: 8 }];
  it('q abaixo de tudo → 0', () => { expect(descontoAplicavel(curva, 50)).toBe(0); });
  it('q na 1ª faixa → 5', () => { expect(descontoAplicavel(curva, 150)).toBe(5); });
  it('q na 2ª faixa → 8 (melhor)', () => { expect(descontoAplicavel(curva, 400)).toBe(8); });
});

describe('prazoAplicavel — prazo da faixa de MAIOR volume aplicável (não a primeira)', () => {
  const curva = [{ volume_minimo: 100, desconto_promo_perc: 0, prazo_perc: 0 }, { volume_minimo: 300, desconto_promo_perc: 10, prazo_perc: 12 }];
  it('q atinge a faixa alta → prazo dela (12), não o da primeira (0)', () => { expect(prazoAplicavel(curva, 300)).toBe(12); });
  it('q só na faixa baixa → prazo da baixa (0)', () => { expect(prazoAplicavel(curva, 150)).toBe(0); });
  it('q abaixo de tudo → null (cai no padrão no caller)', () => { expect(prazoAplicavel(curva, 50)).toBeNull(); });
  it('nenhuma faixa com prazo_perc → null', () => { expect(prazoAplicavel([{ volume_minimo: 100, desconto_promo_perc: 5 }], 200)).toBeNull(); });
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
  it('aumento vigente HOJE (dias_ate_aumento = 0) → 0 (sem janela pra antecipar, não credita fictício)', () => {
    expect(aumentoEvitadoRs({ q_cand: 400, q_base: 100, demanda_diaria: 10, dias_ate_aumento: 0, aumento_perc: 10, preco_unit: 50 })).toBe(0);
  });
});

describe('impactoPrazoRs — (prazo_cand% − prazo_padrão%) × valor_candidato; +encargo=custo', () => {
  it('encargo maior que o padrão → custo positivo (a subtrair)', () => {
    const r = impactoPrazoRs({ prazo_cand_perc: 3, prazo_padrao_perc: 1, valor_candidato: 20000 });
    expect(r).toBeCloseTo(400, 2); // delta 2% × 20000
  });
});

describe('freteIncrementalRs — só o % do valor (fixo/taxa por-pedido são SUNK no mesmo pedido)', () => {
  it('% sobre o valor extra', () => {
    expect(freteIncrementalRs({ valor_extra: 10000, frete_perc_valor: 2 })).toBeCloseTo(200, 2);
  });
  it('frete_perc nulo → 0', () => {
    expect(freteIncrementalRs({ valor_extra: 10000, frete_perc_valor: null })).toBe(0);
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

const base: InsumoSku = {
  empresa: 'oben', sku: '123', fornecedor: 'F', preco_unit: 50, demanda_diaria: 10,
  qtde_base: 100, lote_minimo_fornecedor: 50, minimo_forcado_manual: null, cm_anual: 0.18,
  prazo_padrao_perc: 0, frete_perc_valor: 0, frete_fixo: 0, frete_taxa_pedido: 0,
  aumento_evitado_perc: null, dias_ate_aumento: null, ruptura_valor_estimado: null, ruptura_dias: null,
  curva_desconto: [{ volume_minimo: 300, desconto_promo_perc: 8 }], escopo: 'sku',
};

describe('avaliarComprarMais', () => {
  it('desconto que supera o capital extra → comprar_mais com net > 0', () => {
    const r = avaliarComprarMais(base);
    expect(r.recomendacao).toBe('comprar_mais');
    expect(r.q_candidata).toBe(300);
    expect(r.beneficio_liquido_rs).toBeGreaterThan(0);
    expect(r.desconto_rs).toBeCloseTo(1200, 0); // 300×50×0,08
  });
  it('desconto pequeno e capital alto → manter_base', () => {
    const r = avaliarComprarMais({ ...base, curva_desconto: [{ volume_minimo: 300, desconto_promo_perc: 0.1 }], cm_anual: 2 });
    expect(r.recomendacao).toBe('manter_base');
    expect(r.q_candidata).toBe(r.q_base);
  });
  it('escopo grupo → simulacao_parcial mesmo com net > 0', () => {
    const r = avaliarComprarMais({ ...base, escopo: 'grupo' });
    expect(r.recomendacao).toBe('simulacao_parcial');
  });
  it('sem demanda/qtde_base → falta_dado', () => {
    const r = avaliarComprarMais({ ...base, demanda_diaria: null, qtde_base: null });
    expect(r.recomendacao).toBe('falta_dado');
  });
  it('ruptura sempre 0 na fase 1 + flag', () => {
    const r = avaliarComprarMais({ ...base, ruptura_valor_estimado: 99999, ruptura_dias: 20 });
    expect(r.ruptura_evitada_rs).toBe(0);
    expect(r.flags.join(' ')).toMatch(/ruptura/i);
  });
});

describe('avaliarComprarMais — oportunidade só de aumento', () => {
  it('candidato qtd_oportunidade cobre pós-vigência → aumento evitado > 0 e comprar_mais', () => {
    // q_base = max(qtde_base 100, lote 50) = 100; consumo até vigência = 10×20 = 200;
    // qtd_oportunidade 400 → elegível = 400 − max(100,200) = 200; aumento 10%, preço 50 → 200×50×0,10 = 1000
    const r = avaliarComprarMais({ ...base, curva_desconto: [], aumento_evitado_perc: 10, dias_ate_aumento: 20, qtd_oportunidade: 400, cm_anual: 0.18 });
    expect(r.q_candidata).toBe(400);
    expect(r.aumento_evitado_rs).toBeGreaterThan(0);
    expect(r.recomendacao).toBe('comprar_mais');
  });
});

// Correções do adversarial review (Codex, 2026-06) — bugs em caminhos NÃO-testados.
// (Confirmados no spec 2026-05-25-otimizador-compras-design.md; semântica "comprar mais = aumentar
// o MESMO pedido" confirmada pelo founder → frete fixo/taxa por-pedido são SUNK, não incrementais.)
describe('avaliarComprarMais — correções do review adversarial (Codex)', () => {
  it('bug 1: frete fixo/taxa NÃO rebaixa comprar_mais (mesmo pedido → sunk, não incremental)', () => {
    // o frete_fixo/taxa seria pago no pedido base de qualquer forma → não é custo marginal de comprar mais.
    const r = avaliarComprarMais({ ...base, frete_fixo: 999999, frete_taxa_pedido: 999999 });
    expect(r.recomendacao).toBe('comprar_mais');
    expect(r.frete_incremental_rs).toBe(0); // só o % do valor entra; aqui frete_perc=0
  });
  it('bug 3: prazo da faixa de MAIOR volume aplicável, não a primeira (.find pegava a 1ª)', () => {
    // curva: 100→prazo 0, 300→prazo 12 (encargo). Comprando 300 o prazo aplicável é 12, não 0.
    const r = avaliarComprarMais({ ...base, prazo_padrao_perc: 0,
      curva_desconto: [{ volume_minimo: 100, desconto_promo_perc: 0, prazo_perc: 0 }, { volume_minimo: 300, desconto_promo_perc: 50, prazo_perc: 12 }] });
    expect(r.q_candidata).toBe(300);
    expect(r.impacto_prazo_rs).toBeCloseTo(1800, 0); // (12−0)% × 15000 (faixa 300), NÃO 0 (faixa 100)
  });
  it('flag defensiva: cm_anual ≤ 0 → flag + confiança não-alta (não assume custo de capital 0 calado)', () => {
    const r = avaliarComprarMais({ ...base, cm_anual: 0 });
    expect(r.flags.join(' ')).toMatch(/capital/i);
    expect(r.confianca.nivel).not.toBe('alta');
  });
});

describe('quantidadeCompraInteira', () => {
  it('arredonda PRA CIMA a poeira decimal do estoque (o bug 3,99996 → 4)', () => {
    expect(quantidadeCompraInteira(3.99996)).toBe(4);
    expect(quantidadeCompraInteira(9.99996)).toBe(10);
  });
  it('inteiro permanece inteiro (idempotente)', () => {
    expect(quantidadeCompraInteira(4)).toBe(4);
    expect(quantidadeCompraInteira(18)).toBe(18);
  });
  it('fração genuína também sobe (nunca sub-pedir)', () => {
    expect(quantidadeCompraInteira(3.01)).toBe(4);
    expect(quantidadeCompraInteira(0.0001)).toBe(1);
  });
  it('zero/negativo/limpo → 0 (linha zerada, sem fração)', () => {
    expect(quantidadeCompraInteira(0)).toBe(0);
    expect(quantidadeCompraInteira(-0.5)).toBe(0);
    expect(quantidadeCompraInteira(null)).toBe(0);
    expect(quantidadeCompraInteira(undefined)).toBe(0);
  });
  it('NaN/Infinity → 0 (degradação honesta, nunca propaga lixo)', () => {
    expect(quantidadeCompraInteira(NaN)).toBe(0);
    expect(quantidadeCompraInteira(Infinity)).toBe(0);
  });
});
