import { describe, it, expect } from 'vitest';
import { getPeriod, COMPANY_LABELS, COMPANY_COLORS } from '../types';

describe('getPeriod', () => {
  it('antes do meio-dia → manha; meio-dia ou depois → tarde', () => {
    expect(getPeriod('2026-01-15T08:00:00')).toBe('manha');
    expect(getPeriod('2026-01-15T11:59:00')).toBe('manha');
    expect(getPeriod('2026-01-15T12:00:00')).toBe('tarde');
    expect(getPeriod('2026-01-15T18:30:00')).toBe('tarde');
  });
});

describe('constantes de empresa', () => {
  it('rótulos e cores cobrem as 3 empresas', () => {
    expect(COMPANY_LABELS).toEqual({ oben: 'Oben', colacor: 'Colacor', afiacao: 'Afiação' });
    expect(Object.keys(COMPANY_COLORS)).toEqual(['oben', 'colacor', 'afiacao']);
  });
});
