import { describe, it, expect } from 'vitest';
import { spBusinessDate } from './sp-day';

describe('spBusinessDate', () => {
  it('22h em SP (01:00Z do dia seguinte) ainda é o dia local', () => {
    // 2026-06-01T01:00:00Z = 2026-05-31 22:00 em SP (UTC-3)
    expect(spBusinessDate('2026-06-01T01:00:00Z')).toBe('2026-05-31');
  });
  it('meio-dia UTC = mesmo dia em SP', () => {
    expect(spBusinessDate('2026-05-31T12:00:00Z')).toBe('2026-05-31');
  });
  it('aceita Date', () => {
    expect(spBusinessDate(new Date('2026-05-31T12:00:00Z'))).toBe('2026-05-31');
  });
  it('madrugada UTC ainda é o dia anterior em SP', () => {
    // 2026-05-31T02:00:00Z = 2026-05-30 23:00 em SP
    expect(spBusinessDate('2026-05-31T02:00:00Z')).toBe('2026-05-30');
  });
});
