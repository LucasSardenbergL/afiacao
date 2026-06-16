import { describe, it, expect } from 'vitest';
import {
  percentil,
  calcPisoMC,
  calcAutoRef,
  calcBenchmark,
  avaliarReguaPreco,
} from '../regua-preco-helpers';
import { DISCLAIMERS_FIXOS } from '../types';

describe('percentil (R-7, casa com percentile_cont do SQL)', () => {
  it('p65 por interpolação linear', () => {
    expect(percentil([100, 110, 120, 130], 0.65)).toBeCloseTo(119.5, 6); // corrigido (era 119)
  });
  it('ignora valores não-finitos', () => {
    expect(percentil([100, NaN, 120, Infinity], 0.5)).toBe(110);
  });
  it('vazio / p fora de [0,1] → null', () => {
    expect(percentil([], 0.65)).toBeNull();
    expect(percentil([100], 1.5)).toBeNull();
  });
  it('um elemento → ele mesmo', () => expect(percentil([100], 0.65)).toBe(100));
});

describe('calcPisoMC = cmc/(1-aliquota)', () => {
  it('cmc 98, aliq 14% → 113.95', () => expect(calcPisoMC(98, 0.14)).toBeCloseTo(113.95, 2));
  it('cmc null → null', () => expect(calcPisoMC(null, 0.14)).toBeNull());
  it('aliquota inválida → null', () => {
    expect(calcPisoMC(98, 1)).toBeNull();
    expect(calcPisoMC(98, -0.1)).toBeNull();
  });
});

describe('calcAutoRef', () => {
  it('nunca inventa preço: [100,200] → 100 ou 200, nunca 150/160', () => {
    const r = calcAutoRef([100, 200])!;
    expect([100, 200]).toContain(r.ref);
  });
  it('>=3 obs → media (1 cliente nunca é alta)', () => {
    expect(calcAutoRef([110, 112, 115])!.confianca).toBe('media');
  });
  it('1-2 obs → baixa', () => expect(calcAutoRef([112])!.confianca).toBe('baixa'));
  it('vazio / lixo → null', () => {
    expect(calcAutoRef([])).toBeNull();
    expect(calcAutoRef([NaN, -5])).toBeNull();
  });
});

const gen = (precos: number[], nClientes: number) =>
  precos.map((p, i) => ({ preco: p, clienteId: `c${i % nClientes}` }));

describe('calcBenchmark', () => {
  it('n>=15 & n_eff>=5 → media', () => {
    const r = calcBenchmark(gen(Array.from({ length: 16 }, (_, i) => 100 + i), 6));
    expect(r.confianca).toBe('media');
    expect(r.nEff).toBeGreaterThanOrEqual(5);
  });
  it('n>=8 & n_eff>=3 (mas <media) → baixa (recibo, sem botão)', () => {
    expect(calcBenchmark(gen(Array.from({ length: 9 }, (_, i) => 100 + i), 4)).confianca).toBe('baixa');
  });
  it('SKU concentrado num cliente → n_eff baixo → oculto', () => {
    const comp = Array.from({ length: 20 }, (_, i) => ({ preco: 100 + i, clienteId: i < 18 ? 'c0' : `c${i}` }));
    expect(calcBenchmark(comp).confianca).toBe('oculto');
  });
  it('preços <=0 filtrados', () => {
    const r = calcBenchmark([{ preco: -1, clienteId: 'c0' }, ...gen([100, 110, 120], 3)]);
    expect(r.n).toBe(3);
  });
});

const base = {
  precoAtual: 106,
  cmc: 98,
  cmcConfiavel: true,
  aliquotaVenda: 0.14,
  precosCliente: [] as number[],
  comparaveis: [] as { preco: number; clienteId: string }[],
  caps: { alta: 0.1, media: 0.05 },
};
const benchAlto = (preco: number) =>
  Array.from({ length: 16 }, (_, i) => ({ preco: preco + (i % 4), clienteId: `c${i % 6}` }));

describe('avaliarReguaPreco', () => {
  it('🔴 piso vence (MC negativa) com botão se CMC confiável', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 106 });
    expect(r.sinal).toBe('piso');
    expect(r.abaixoPiso).toBe(true);
    expect(r.precoReferencia).not.toBeNull();
    expect(r.disclaimers).toEqual(expect.arrayContaining(DISCLAIMERS_FIXOS));
  });
  it('CMC proxy abaixo do piso → aviso SEM botão', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 106, cmcConfiavel: false });
    expect(r.sinal).toBe('piso');
    expect(r.precoReferencia).toBeNull();
    expect(r.reasonCodes).toContain('cmc_proxy');
  });
  it('precoAtual<=0 → nenhum/oculto, não explode', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 0 });
    expect(r.sinal).toBe('nenhum');
    expect(r.suggestedGapPct).toBeNull();
    expect(r.reasonCodes).toContain('preco_atual_invalido');
  });
  it('teto = min(auto,benchmark): usa o MENOR (bench 125), não a auto (160)', () => {
    // bench constante 125 (n=16, n_eff>=5 → media); auto 160; cap media 5% sobre 120 = 126 (não morde os 125).
    const comparaveis = Array.from({ length: 16 }, (_, i) => ({ preco: 125, clienteId: `c${i % 6}` }));
    const r = avaliarReguaPreco({ ...base, precoAtual: 120, precosCliente: [160, 160, 160], comparaveis });
    expect(r.precoReferencia).toBeCloseTo(125, 6); // min(160,125)=125 — se usasse a auto sairia 126
  });
  it('discordância (cliente paga MENOS, carteira MAIS) → degrada sem botão', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 120, precosCliente: [100, 100, 100], comparaveis: benchAlto(135) });
    expect(r.discordancia).toBe(true);
    expect(r.precoReferencia).toBeNull();
    expect(r.reasonCodes).toContain('sinais_discordantes');
  });
  it('preço já acima de tudo → nenhum, mas confiança = evidência real (não baixa)', () => {
    const r = avaliarReguaPreco({ ...base, precoAtual: 200, comparaveis: benchAlto(120) });
    expect(r.sinal).toBe('nenhum');
    expect(r.confianca).toBe('media');
    expect(r.reasonCodes).toContain('preco_acima_referencias');
  });
  it('observedGapPct (não capado) > suggestedGapPct (capado) quando o cap morde', () => {
    // precoAtual 120 ACIMA do piso (113,95); auto 160 → teto 160; cap media 5% → alvo 126.
    const r = avaliarReguaPreco({ ...base, precoAtual: 120, precosCliente: [160, 160, 160], comparaveis: [] });
    expect(r.sinal).toBe('auto_ref');
    expect(r.observedGapPct!).toBeGreaterThan(r.suggestedGapPct!); // 0.333 > 0.05
    expect(r.capLimitou).toBe(true);
  });
});
