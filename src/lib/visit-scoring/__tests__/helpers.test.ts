import { describe, it, expect } from 'vitest';
import { clamp, normalizeRevenue, computeDays } from '../helpers';

describe('clamp', () => {
  it('valor dentro do range não muda', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('valor abaixo do min vai pro min', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('valor acima do max vai pro max', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

describe('normalizeRevenue', () => {
  it('valor zero retorna 0', () => {
    expect(normalizeRevenue(0)).toBe(0);
  });

  it('valor médio (~R$ 5000) retorna meio (~0.5)', () => {
    expect(normalizeRevenue(5000)).toBeCloseTo(0.5, 1);
  });

  it('valor alto (>= R$ 10000) satura em 1.0', () => {
    expect(normalizeRevenue(10000)).toBe(1);
    expect(normalizeRevenue(50000)).toBe(1);
  });
});

describe('computeDays', () => {
  it('null retorna null', () => {
    expect(computeDays(null)).toBeNull();
  });

  it('undefined retorna null', () => {
    expect(computeDays(undefined)).toBeNull();
  });

  it('timestamp de hoje retorna 0', () => {
    const now = new Date().toISOString();
    expect(computeDays(now)).toBe(0);
  });
});
