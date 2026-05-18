import { describe, it, expect } from 'vitest';
import { applyTemporalDecay, daysBetween } from '../decay';

describe('decay', () => {
  describe('daysBetween', () => {
    it('retorna 0 pra mesmo dia', () => {
      const d = new Date('2026-05-18T10:00:00Z');
      expect(daysBetween(d, d)).toBe(0);
    });

    it('conta dias entre datas', () => {
      const a = new Date('2026-05-01T10:00:00Z');
      const b = new Date('2026-05-15T10:00:00Z');
      expect(daysBetween(a, b)).toBe(14);
    });

    it('é simétrico (absoluto)', () => {
      const a = new Date('2026-05-01T10:00:00Z');
      const b = new Date('2026-05-15T10:00:00Z');
      expect(daysBetween(b, a)).toBe(14);
    });
  });

  describe('applyTemporalDecay', () => {
    it('peso integral em 0 dias', () => {
      expect(applyTemporalDecay(1.0, 0)).toBe(1.0);
    });

    it('peso = 0.5 em 30 dias (half-life)', () => {
      expect(applyTemporalDecay(1.0, 30)).toBeCloseTo(0.5, 2);
    });

    it('peso = 0.25 em 60 dias (2 half-lives)', () => {
      expect(applyTemporalDecay(1.0, 60)).toBeCloseTo(0.25, 2);
    });

    it('peso = 0.125 em 90 dias', () => {
      expect(applyTemporalDecay(1.0, 90)).toBeCloseTo(0.125, 2);
    });

    it('escala linearmente com weight inicial', () => {
      expect(applyTemporalDecay(2.0, 30)).toBeCloseTo(1.0, 2);
      expect(applyTemporalDecay(0.5, 30)).toBeCloseTo(0.25, 2);
    });

    it('nunca retorna negativo', () => {
      expect(applyTemporalDecay(1.0, 365)).toBeGreaterThan(0);
    });
  });
});
