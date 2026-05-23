// src/lib/call-log/recording-policy.test.ts
import { describe, it, expect } from 'vitest';
import { shouldAutoRecord } from './recording-policy';

describe('shouldAutoRecord', () => {
  it('grava automaticamente para cliente', () => {
    expect(shouldAutoRecord('cliente')).toBe(true);
  });
  it('grava automaticamente para fornecedor (ramo dormente, mas pronto)', () => {
    expect(shouldAutoRecord('fornecedor')).toBe(true);
  });
  it('NÃO grava automaticamente para desconhecido/avulso', () => {
    expect(shouldAutoRecord('desconhecido')).toBe(false);
  });
});
