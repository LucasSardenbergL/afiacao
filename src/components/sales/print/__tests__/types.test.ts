import { describe, it, expect } from 'vitest';
import { getPeriod, COMPANY_LABELS, COMPANY_COLORS } from '../types';

describe('getPeriod', () => {
  it('antes do meio-dia → manha; meio-dia ou depois → tarde', () => {
    expect(getPeriod('2026-01-15T08:00:00')).toBe('manha');
    expect(getPeriod('2026-01-15T11:59:00')).toBe('manha');
    expect(getPeriod('2026-01-15T12:00:00')).toBe('tarde');
    expect(getPeriod('2026-01-15T18:30:00')).toBe('tarde');
  });

  it('data-pura do sync (meia-noite UTC) → manha pelo relógio UTC, não "tarde" fabricada pelo fuso local', () => {
    // Em BRT, 00:00Z é 21:00 local do dia anterior — o relógio local fabricaria "tarde".
    expect(getPeriod('2026-06-10T00:00:00.000Z')).toBe('manha');
  });

  it('meia-noite com offset local (instante real, não data-pura) segue o relógio local', () => {
    const meiaNoiteLocal = new Date(2026, 0, 15, 0, 30).toISOString();
    expect(getPeriod(meiaNoiteLocal)).toBe('manha');
  });
});

describe('constantes de empresa', () => {
  it('rótulos e cores cobrem as 3 empresas', () => {
    expect(COMPANY_LABELS).toEqual({ oben: 'Oben', colacor: 'Colacor', afiacao: 'Afiação' });
    expect(Object.keys(COMPANY_COLORS)).toEqual(['oben', 'colacor', 'afiacao']);
  });
});
