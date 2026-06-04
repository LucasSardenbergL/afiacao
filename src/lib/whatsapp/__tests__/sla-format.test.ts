import { describe, it, expect } from 'vitest';
import { formatSlaWait, slaNivelClasses } from '../sla-format';

describe('formatSlaWait', () => {
  it('zero e negativo → "0 min"', () => {
    expect(formatSlaWait(0)).toBe('0 min');
    expect(formatSlaWait(-5)).toBe('0 min');
    expect(formatSlaWait(NaN)).toBe('0 min');
  });
  it('abaixo de 1h → minutos', () => {
    expect(formatSlaWait(18)).toBe('18 min');
    expect(formatSlaWait(59)).toBe('59 min');
    expect(formatSlaWait(18.9)).toBe('18 min'); // floor
  });
  it('1h ou mais → "Hh" / "HhMM"', () => {
    expect(formatSlaWait(60)).toBe('1h');
    expect(formatSlaWait(65)).toBe('1h05');
    expect(formatSlaWait(125)).toBe('2h05');
    expect(formatSlaWait(130)).toBe('2h10');
  });
});

describe('slaNivelClasses', () => {
  it('mapeia nível → classes de status', () => {
    expect(slaNivelClasses('vermelho')).toContain('text-status-error');
    expect(slaNivelClasses('amarelo')).toContain('text-status-warning');
    expect(slaNivelClasses('verde')).toContain('text-status-success');
  });
});
