import { describe, it, expect } from 'vitest';
import { diasDesde, recenciaLabel } from '../recencia';

const HOJE = '2026-06-01';

describe('diasDesde', () => {
  it('null/vazio → null', () => {
    expect(diasDesde(null, HOJE)).toBeNull();
    expect(diasDesde(undefined, HOJE)).toBeNull();
    expect(diasDesde('', HOJE)).toBeNull();
  });
  it('mesmo dia → 0', () => {
    expect(diasDesde('2026-06-01', HOJE)).toBe(0);
    expect(diasDesde('2026-06-01T23:59:00Z', HOJE)).toBe(0);
  });
  it('ontem → 1; N dias atrás → N', () => {
    expect(diasDesde('2026-05-31', HOJE)).toBe(1);
    expect(diasDesde('2026-05-20', HOJE)).toBe(12);
    expect(diasDesde('2026-05-02', HOJE)).toBe(30);
  });
  it('data inválida → null', () => {
    expect(diasDesde('xyz', HOJE)).toBeNull();
  });
});

describe('recenciaLabel', () => {
  it('mapeia recência', () => {
    expect(recenciaLabel(null, HOJE)).toBe('nunca');
    expect(recenciaLabel('2026-06-01', HOJE)).toBe('hoje');
    expect(recenciaLabel('2026-05-31', HOJE)).toBe('ontem');
    expect(recenciaLabel('2026-05-20', HOJE)).toBe('há 12 dias');
  });
  it('data futura → hoje (não negativo)', () => {
    expect(recenciaLabel('2026-06-05', HOJE)).toBe('hoje');
  });
});
