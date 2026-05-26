import { describe, it, expect } from 'vitest';
import {
  validateAno,
  validateMes,
  resolveDrePeriod,
  DrePeriodError,
} from '../dre-period';

describe('validateAno', () => {
  it('aceita ano inteiro no intervalo', () => {
    expect(validateAno(2026)).toBe(2026);
    expect(validateAno(2000)).toBe(2000);
    expect(validateAno(2100)).toBe(2100);
  });

  it('aceita string só-dígitos e coage a número', () => {
    expect(validateAno('2026')).toBe(2026);
    expect(validateAno('  2026  ')).toBe(2026);
  });

  it('rejeita float (não silencia pra inteiro)', () => {
    expect(() => validateAno(2026.5)).toThrow(DrePeriodError);
  });

  it('rejeita fora do intervalo 2000-2100', () => {
    expect(() => validateAno(1999)).toThrow(DrePeriodError);
    expect(() => validateAno(2101)).toThrow(DrePeriodError);
    expect(() => validateAno(0)).toThrow(DrePeriodError);
  });

  it('rejeita injeção / não-numérico', () => {
    expect(() => validateAno('2026),or(id.gte.0')).toThrow(DrePeriodError);
    expect(() => validateAno('abc')).toThrow(DrePeriodError);
    expect(() => validateAno(NaN)).toThrow(DrePeriodError);
    expect(() => validateAno(null)).toThrow(DrePeriodError);
    expect(() => validateAno(undefined)).toThrow(DrePeriodError);
  });
});

describe('validateMes', () => {
  it('aceita 1 a 12', () => {
    expect(validateMes(1)).toBe(1);
    expect(validateMes(12)).toBe(12);
    expect(validateMes('6')).toBe(6);
  });

  it('rejeita fora de 1-12', () => {
    expect(() => validateMes(0)).toThrow(DrePeriodError);
    expect(() => validateMes(13)).toThrow(DrePeriodError);
  });

  it('rejeita float e injeção', () => {
    expect(() => validateMes(6.5)).toThrow(DrePeriodError);
    expect(() => validateMes('01),or(id.gte.0')).toThrow(DrePeriodError);
    expect(() => validateMes('evil')).toThrow(DrePeriodError);
  });
});

describe('resolveDrePeriod', () => {
  const defaults = { defaultAno: 2026, defaultMes: 5 };

  it('campos ausentes → usa os defaults contratados', () => {
    expect(resolveDrePeriod({ ...defaults })).toEqual({ ano: 2026, meses: [5] });
    expect(resolveDrePeriod({ ano: null, mes: undefined, ...defaults })).toEqual({ ano: 2026, meses: [5] });
  });

  it('ano/mes presentes e válidos → usa os validados', () => {
    expect(resolveDrePeriod({ ano: 2025, mes: 3, ...defaults })).toEqual({ ano: 2025, meses: [3] });
    expect(resolveDrePeriod({ ano: '2024', mes: '12', ...defaults })).toEqual({ ano: 2024, meses: [12] });
  });

  it('meses (array) tem precedência sobre mes', () => {
    expect(resolveDrePeriod({ meses: [1, 2, 3], mes: 9, ...defaults })).toEqual({ ano: 2026, meses: [1, 2, 3] });
  });

  it('ano presente mas inválido → throw (não cai pro default)', () => {
    expect(() => resolveDrePeriod({ ano: '2026),or(1.eq.1', ...defaults })).toThrow(DrePeriodError);
    expect(() => resolveDrePeriod({ ano: 1800, ...defaults })).toThrow(DrePeriodError);
  });

  it('mes presente mas inválido → throw', () => {
    expect(() => resolveDrePeriod({ mes: '01),or(1.eq.1', ...defaults })).toThrow(DrePeriodError);
    expect(() => resolveDrePeriod({ mes: 99, ...defaults })).toThrow(DrePeriodError);
  });

  it('meses com elemento inválido → throw', () => {
    expect(() => resolveDrePeriod({ meses: [1, '02),evil', 3], ...defaults })).toThrow(DrePeriodError);
  });

  it('meses não-array ou vazio → throw', () => {
    expect(() => resolveDrePeriod({ meses: 5, ...defaults })).toThrow(DrePeriodError);
    expect(() => resolveDrePeriod({ meses: [], ...defaults })).toThrow(DrePeriodError);
  });
});
