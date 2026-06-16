import { describe, it, expect } from 'vitest';
import { spDayRangeUtc } from '../sp-day';

describe('spDayRangeUtc — janela do dia em America/Sao_Paulo como instantes UTC', () => {
  it('dia em SP (UTC-3) → [03:00Z do dia, 03:00Z do dia seguinte)', () => {
    // 14:00 SP = 17:00Z, claramente dentro do dia 27 em SP
    const { startUtc, endUtc } = spDayRangeUtc(new Date('2026-05-27T17:00:00.000Z'));
    expect(startUtc).toBe('2026-05-27T03:00:00.000Z');
    expect(endUtc).toBe('2026-05-28T03:00:00.000Z');
  });

  it('BUG QUE CORRIGE: 23:30 SP (= 02:30Z do dia seguinte) ainda é o dia 27 em SP', () => {
    // now = 2026-05-28T02:30Z; toISOString().slice(0,10) daria "2026-05-28" (dia errado) →
    // a query antiga .gte("2026-05-28") perderia todas as calls do dia 27. Aqui a janela
    // permanece no 27.
    const now = new Date('2026-05-27T23:30:00-03:00'); // = 2026-05-28T02:30:00Z
    expect(now.toISOString()).toBe('2026-05-28T02:30:00.000Z'); // sanidade: já virou no UTC
    const { startUtc, endUtc } = spDayRangeUtc(now);
    expect(startUtc).toBe('2026-05-27T03:00:00.000Z');
    expect(endUtc).toBe('2026-05-28T03:00:00.000Z');
  });

  it('madrugada em SP (01:00 SP = 04:00Z) → janela do mesmo dia local', () => {
    const now = new Date('2026-05-27T01:00:00-03:00'); // = 04:00Z
    const { startUtc, endUtc } = spDayRangeUtc(now);
    expect(startUtc).toBe('2026-05-27T03:00:00.000Z');
    expect(endUtc).toBe('2026-05-28T03:00:00.000Z');
    // o instante atual cai dentro de [start, end)
    expect(now.getTime()).toBeGreaterThanOrEqual(new Date(startUtc).getTime());
    expect(now.getTime()).toBeLessThan(new Date(endUtc).getTime());
  });

  it('janela tem exatamente 24h', () => {
    const { startUtc, endUtc } = spDayRangeUtc(new Date('2026-05-27T12:00:00.000Z'));
    expect(new Date(endUtc).getTime() - new Date(startUtc).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
