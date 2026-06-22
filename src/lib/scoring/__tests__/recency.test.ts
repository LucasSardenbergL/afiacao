import { describe, it, expect } from 'vitest';
import { computeRecencyScore, clampRecencyCapDays } from '../recency';

describe('clampRecencyCapDays', () => {
  it('mantém um teto válido no intervalo', () => {
    expect(clampRecencyCapDays(180)).toBe(180);
    expect(clampRecencyCapDays(365)).toBe(365);
  });

  it('clampa acima de 999 (guardrail: T>999 ressuscitaria o sentinela)', () => {
    expect(clampRecencyCapDays(1200)).toBe(999);
    expect(clampRecencyCapDays(2235)).toBe(999);
  });

  it('clampa abaixo de 30', () => {
    expect(clampRecencyCapDays(10)).toBe(30);
    expect(clampRecencyCapDays(0)).toBe(30);
    expect(clampRecencyCapDays(-5)).toBe(30);
  });

  it('arredonda para inteiro', () => {
    expect(clampRecencyCapDays(200.7)).toBe(201);
  });

  it('cai no default 180 para valor ausente/inválido (não fabrica teto; null NÃO vira 0→30)', () => {
    expect(clampRecencyCapDays(undefined)).toBe(180);
    expect(clampRecencyCapDays(null)).toBe(180); // armadilha Number(null)===0 → seria 30 sem guard
    expect(clampRecencyCapDays(NaN)).toBe(180);
    expect(clampRecencyCapDays('abc')).toBe(180);
  });
});

describe('computeRecencyScore (cap linear)', () => {
  it('comprou hoje (0 dias) → recência máxima', () => {
    expect(computeRecencyScore(0, 180)).toBe(100);
  });

  it('decai linearmente até o teto', () => {
    expect(computeRecencyScore(30, 180)).toBeCloseTo(83.33, 1);
    expect(computeRecencyScore(90, 180)).toBe(50);
  });

  it('zera no teto e além (cap: 180/999/2235 empatam em 0)', () => {
    expect(computeRecencyScore(180, 180)).toBe(0);
    expect(computeRecencyScore(999, 180)).toBe(0);
    expect(computeRecencyScore(2235, 180)).toBe(0);
  });

  it('sentinela sem-venda (999) → 0, NÃO 55 (mata a fabricação da normalização ÷max)', () => {
    expect(computeRecencyScore(999, 180)).toBe(0);
  });

  it('days ausente/NaN/null/undefined → recência 0, nunca 100 (money-path: ausente ≠ comprou-hoje)', () => {
    expect(computeRecencyScore(NaN, 180)).toBe(0);
    expect(computeRecencyScore(Infinity, 180)).toBe(0);
    expect(computeRecencyScore(null, 180)).toBe(0);
    expect(computeRecencyScore(undefined, 180)).toBe(0);
  });

  it('days negativo (data futura do Omie) → clampa em 0 → recência 100', () => {
    expect(computeRecencyScore(-5, 180)).toBe(100);
  });

  it('aplica o guardrail do teto: cap 1200 vira 999 antes de normalizar', () => {
    expect(computeRecencyScore(90, 1200)).toBeCloseTo(computeRecencyScore(90, 999), 5);
    // com cap=999: 100 - 90/999*100 ≈ 90.99 (NÃO 50, que seria cap=180)
    expect(computeRecencyScore(90, 1200)).toBeCloseTo(90.99, 1);
  });

  it('teto maior é mais leniente (T=365 dá gradação onde T=180 zera)', () => {
    expect(computeRecencyScore(180, 180)).toBe(0);
    expect(computeRecencyScore(180, 365)).toBeCloseTo(50.68, 1); // 100 - 180/365*100
  });
});
