import { describe, it, expect } from 'vitest';
import { hojeSP, addDias, inicioMes, spMeiaNoiteUTC } from '../sp-date';

describe('sp-date', () => {
  it('addDias atravessa fronteira de mês/ano', () => {
    expect(addDias('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDias('2026-06-04', -6)).toBe('2026-05-29');
    expect(addDias('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDias('2026-06-04', 0)).toBe('2026-06-04');
  });

  it('inicioMes → primeiro dia do mês', () => {
    expect(inicioMes('2026-06-15')).toBe('2026-06-01');
    expect(inicioMes('2026-12-31')).toBe('2026-12-01');
  });

  it('spMeiaNoiteUTC → T03:00Z (SP = UTC−3 fixo)', () => {
    expect(spMeiaNoiteUTC('2026-06-04')).toBe('2026-06-04T03:00:00.000Z');
  });

  it('hojeSP → string YYYY-MM-DD', () => {
    expect(hojeSP()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
