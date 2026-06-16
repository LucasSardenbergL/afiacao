import { describe, it, expect } from 'vitest';
import { fmt, formatTimer, CALL_TYPES, CALL_RESULTS, AGENDA_TYPE_META } from '../types';

describe('formatTimer', () => {
  it('formata segundos como MM:SS com zero-pad', () => {
    expect(formatTimer(0)).toBe('00:00');
    expect(formatTimer(9)).toBe('00:09');
    expect(formatTimer(65)).toBe('01:05');
    expect(formatTimer(600)).toBe('10:00');
    expect(formatTimer(3661)).toBe('61:01');
  });
});

describe('fmt', () => {
  it('formata número como moeda BRL', () => {
    expect(fmt(0)).toContain('0,00');
    expect(fmt(1234.5)).toContain('1.234,50');
    expect(fmt(1234.5)).toContain('R$');
  });
});

describe('constantes', () => {
  it('CALL_TYPES e CALL_RESULTS têm os valores esperados', () => {
    expect(CALL_TYPES.map(t => t.value)).toEqual(['reativacao', 'cross_sell', 'up_sell', 'follow_up']);
    expect(CALL_RESULTS.map(r => r.value)).toContain('contato_sucesso');
    expect(CALL_RESULTS.map(r => r.value)).toContain('reagendado');
  });

  it('AGENDA_TYPE_META cobre risco/expansao/follow_up', () => {
    expect(AGENDA_TYPE_META.risco.label).toBe('Risco');
    expect(AGENDA_TYPE_META.expansao.label).toBe('Expansão');
    expect(AGENDA_TYPE_META.follow_up.label).toBe('Follow-up');
  });
});
