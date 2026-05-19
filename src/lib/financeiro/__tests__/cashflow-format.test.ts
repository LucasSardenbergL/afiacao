import { describe, it, expect } from 'vitest';
import {
  formatSemana,
  formatBRL,
  formatDelta,
  expandirRecorrente,
  inicioSemana,
} from '../cashflow-format';

describe('formatSemana', () => {
  it('formats YYYY-MM-DD week as "DD/MM"', () => {
    expect(formatSemana('2026-05-19')).toBe('19/05');
  });
});

describe('formatBRL', () => {
  it('formats positive as R$ X.XXX,XX', () => {
    expect(formatBRL(1234.5)).toMatch(/R\$\s?1\.234,50/);
  });
  it('formats negative with sinal', () => {
    expect(formatBRL(-500)).toMatch(/-R\$\s?500,00/);
  });
  it('formats zero', () => {
    expect(formatBRL(0)).toMatch(/R\$\s?0,00/);
  });
});

describe('formatDelta', () => {
  it('positive delta has + prefix', () => {
    expect(formatDelta(100)).toMatch(/^\+/);
  });
  it('negative delta has - prefix', () => {
    expect(formatDelta(-100)).toMatch(/^-/);
  });
  it('zero has no prefix', () => {
    expect(formatDelta(0)).not.toMatch(/^[+-]/);
  });
});

describe('inicioSemana', () => {
  it('returns Monday for any day of the week (ISO week)', () => {
    expect(inicioSemana('2026-05-21')).toBe('2026-05-18');
  });
  it('returns same day if input is Monday', () => {
    expect(inicioSemana('2026-05-18')).toBe('2026-05-18');
  });
});

describe('expandirRecorrente', () => {
  it('returns one occurrence per month within window', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 5,
      inicio: '2026-05-01',
      fim: null,
    }, { de: '2026-05-01', ate: '2026-07-31' });
    expect(ocorrencias).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
  });

  it('clamps day 31 to last day of month for February', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 31,
      inicio: '2026-01-01',
      fim: null,
    }, { de: '2026-01-01', ate: '2026-03-31' });
    expect(ocorrencias).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('respects inicio (no occurrences before)', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 15,
      inicio: '2026-06-01',
      fim: null,
    }, { de: '2026-05-01', ate: '2026-07-31' });
    expect(ocorrencias).toEqual(['2026-06-15', '2026-07-15']);
  });

  it('respects fim (no occurrences after)', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 10,
      inicio: '2026-05-01',
      fim: '2026-06-15',
    }, { de: '2026-05-01', ate: '2026-08-31' });
    expect(ocorrencias).toEqual(['2026-05-10', '2026-06-10']);
  });
});
