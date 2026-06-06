import { describe, it, expect } from 'vitest';
import {
  clampDesconto, premioAnual, loteOtimo, netNoLote, netNoOtimo, avaliarNegociacao,
  DESCONTO_PADRAO,
} from '../negociacao-valor-helpers';
import type { InsumoNegociacao } from '../negociacao-valor-helpers';

describe('clampDesconto', () => {
  it('mantém desconto válido', () => {
    expect(clampDesconto(0.07)).toBe(0.07);
    expect(clampDesconto(0.10)).toBe(0.10);
  });
  it('inválido/≤0/NaN → default 8%', () => {
    expect(clampDesconto(0)).toBe(DESCONTO_PADRAO);
    expect(clampDesconto(-0.05)).toBe(DESCONTO_PADRAO);
    expect(clampDesconto(NaN)).toBe(DESCONTO_PADRAO);
  });
  it('clampeia acima de 50%', () => {
    expect(clampDesconto(0.9)).toBe(0.5);
  });
});

describe('premioAnual = δ·p·A', () => {
  it('caso simples', () => {
    expect(premioAnual(0.10, 10, 100)).toBeCloseTo(100, 4);
  });
  it('falta preço de compra → null', () => {
    expect(premioAnual(0.10, null, 100)).toBeNull();
    expect(premioAnual(0.10, 0, 100)).toBeNull();
  });
  it('sem giro (A≤0) → null', () => {
    expect(premioAnual(0.10, 10, 0)).toBeNull();
  });
});

describe('loteOtimo = δ·p·A/(c·k) e netNoOtimo = (δp)²·A/(2ck)', () => {
  it('caso simples (A=100,p=10,c=10,k=0.2,δ=0.1)', () => {
    expect(loteOtimo(0.10, 10, 10, 100, 0.20)).toBeCloseTo(50, 4);
    expect(netNoOtimo(0.10, 10, 10, 100, 0.20)).toBeCloseTo(25, 4);
  });
  it('p<c reduz o lote ótimo e o net (A=100,p=9,c=10,k=0.2,δ=0.1)', () => {
    expect(loteOtimo(0.10, 9, 10, 100, 0.20)).toBeCloseTo(45, 4);
    expect(netNoOtimo(0.10, 9, 10, 100, 0.20)).toBeCloseTo(20.25, 4);
  });
  it('falta c → null (sem CMC)', () => {
    expect(loteOtimo(0.10, 9, null, 100, 0.20)).toBeNull();
    expect(netNoOtimo(0.10, 9, null, 100, 0.20)).toBeNull();
  });
});

describe('netNoLote = δ·p·Q − c·k·Q²/(2A)', () => {
  it('no lote ótimo bate com netNoOtimo', () => {
    // Q*=50; net=0.1·10·50 − 10·0.2·2500/(200) = 50 − 25 = 25
    expect(netNoLote(0.10, 10, 10, 100, 0.20, 50)).toBeCloseTo(25, 4);
  });
  it('acima do teto (Q=2·Q*) o net zera', () => {
    expect(netNoLote(0.10, 10, 10, 100, 0.20, 100)).toBeCloseTo(0, 4);
  });
});

describe('avaliarNegociacao — caso real CATALISADOR (base separada)', () => {
  const ins: InsumoNegociacao = {
    sku_codigo_omie: '8689743956',
    sku_descricao: 'CATALISADOR FC.6975LT',
    consumo_anual: 287.9,
    preco_compra: 436.84,
    cmc: 536.48,
    custo_capital_anual: 0.258,
  };
  it('δ=8%: prêmio ~10.061, lote ~72,7, net ~1.270, ~3 meses', () => {
    const r = avaliarNegociacao(ins, 0.08);
    expect(r.elegivel).toBe(true);
    expect(r.premio_anual).toBeCloseTo(10061.30, 0);
    expect(r.lote_otimo).toBeCloseTo(72.69, 1);
    expect(r.teto_volume).toBeCloseTo(145.38, 1);
    expect(r.net_negociacao).toBeCloseTo(1270.17, 0);
    expect(r.meses_otimo).toBeCloseTo(3.03, 1);
    expect(r.meses_teto).toBeCloseTo(6.06, 1);
  });
  it('δ=7% (gerente devolveu menos): prêmio ~8.804, net ~972', () => {
    const r = avaliarNegociacao(ins, 0.07);
    expect(r.premio_anual).toBeCloseTo(8803.64, 0);
    expect(r.net_negociacao).toBeCloseTo(972.48, 0);
  });
});

describe('avaliarNegociacao — degradação honesta', () => {
  const base: InsumoNegociacao = {
    sku_codigo_omie: 'x', sku_descricao: 'x', consumo_anual: 100,
    preco_compra: 10, cmc: 10, custo_capital_anual: 0.2,
  };
  it('sem giro → inelegível motivo sem_giro', () => {
    const r = avaliarNegociacao({ ...base, consumo_anual: 0 }, 0.08);
    expect(r.elegivel).toBe(false);
    expect(r.motivo_inelegivel).toBe('sem_giro');
    expect(r.net_negociacao).toBeNull();
  });
  it('sem preço de compra → inelegível sem_preco_compra', () => {
    const r = avaliarNegociacao({ ...base, preco_compra: null }, 0.08);
    expect(r.elegivel).toBe(false);
    expect(r.motivo_inelegivel).toBe('sem_preco_compra');
  });
  it('sem CMC → inelegível sem_cmc, mas ainda mostra prêmio (custo a confirmar)', () => {
    const r = avaliarNegociacao({ ...base, cmc: null }, 0.08);
    expect(r.elegivel).toBe(false);
    expect(r.motivo_inelegivel).toBe('sem_cmc');
    expect(r.premio_anual).toBeCloseTo(80, 4); // δ(0.08) · p(10) · A(100) = 80 — prêmio sobrevive sem CMC
    expect(r.net_negociacao).toBeNull();
    expect(r.lote_otimo).toBeNull();
  });
});
