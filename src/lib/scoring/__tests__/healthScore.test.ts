import { describe, it, expect } from 'vitest';
import { calcularHealthScore, type PesosHealth } from '../healthScore';

// Oráculo da composição do health score do motor client-side (useFarmerScoring).
//
// O ponto: margem DESCONHECIDA não pode entrar como 0 numa média ponderada. Entrar como 0
// não é neutro — é a pior nota possível naquele eixo, então o cliente sem custo apurado
// levaria uma penalidade de até 15 pontos por um dado que ninguém mediu.
//
// ESPELHO da renormalização que o #1495 aplicou em supabase/functions/calculate-scores.

const PESOS: PesosHealth = { rf: 0.35, m: 0.2, g: 0.15, x: 0.15, s: 0.15 };

describe('calcularHealthScore — margem conhecida', () => {
  it('compõe a média ponderada normalmente', () => {
    // 100*(0.35*1 + 0.20*1 + 0.15*1 + 0.15*1 + 0.15*1) = 100
    expect(calcularHealthScore({ rf: 1, m: 1, g: 1, x: 1, s: 1 }, PESOS)).toBe(100);
  });

  it('g = 0 CONHECIDO penaliza de verdade (margem nula real é veredito)', () => {
    // 100*(0.35 + 0.20 + 0 + 0.15 + 0.15) = 85. toBeCloseTo porque a soma de floats
    // devolve 85.00000000000001 — a fórmula está certa, a igualdade exata é que não cabe.
    expect(calcularHealthScore({ rf: 1, m: 1, g: 0, x: 1, s: 1 }, PESOS)).toBeCloseTo(85, 6);
  });
});

describe('calcularHealthScore — margem desconhecida renormaliza', () => {
  it('g null NÃO penaliza: o peso é redistribuído entre as dimensões conhecidas', () => {
    // Sem renormalizar seriam 85 (o mesmo que margem zero conhecida) — indistinguível de
    // "cliente ruim". Renormalizado: 100*(0.85/0.85) = 100.
    expect(calcularHealthScore({ rf: 1, m: 1, g: null, x: 1, s: 1 }, PESOS)).toBe(100);
  });

  it('g null preserva a proporção entre as demais dimensões', () => {
    // rf=1, m=0, x=1, s=0 → (0.35 + 0.15) / 0.85 = 0.5882... → 58.82
    const r = calcularHealthScore({ rf: 1, m: 0, g: null, x: 1, s: 0 }, PESOS);
    expect(r).toBeCloseTo(58.82, 1);
  });

  it('cliente sem margem não fica ABAIXO do idêntico com margem zero conhecida', () => {
    const semMargem = calcularHealthScore({ rf: 0.5, m: 0.5, g: null, x: 0.5, s: 0.5 }, PESOS);
    const margemZero = calcularHealthScore({ rf: 0.5, m: 0.5, g: 0, x: 0.5, s: 0.5 }, PESOS);
    expect(semMargem).toBeGreaterThan(margemZero);
  });
});

describe('calcularHealthScore — bordas', () => {
  it('todos os pesos zerados → 0, sem NaN de 0/0', () => {
    const r = calcularHealthScore(
      { rf: 1, m: 1, g: 1, x: 1, s: 1 },
      { rf: 0, m: 0, g: 0, x: 0, s: 0 },
    );
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });

  it('só a margem tem peso e ela é desconhecida → 0, não NaN', () => {
    const r = calcularHealthScore(
      { rf: 1, m: 1, g: null, x: 1, s: 1 },
      { rf: 0, m: 0, g: 1, x: 0, s: 0 },
    );
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });

  it('pesos que não somam 1 ainda produzem escala 0-100 (a divisão normaliza)', () => {
    const r = calcularHealthScore(
      { rf: 1, m: 1, g: 1, x: 1, s: 1 },
      { rf: 0.5, m: 0.5, g: 0.5, x: 0.5, s: 0.5 },
    );
    expect(r).toBe(100);
  });
});
