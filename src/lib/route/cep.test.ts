import { describe, it, expect } from 'vitest';
import { normalizarCep } from './cep';

describe('normalizarCep', () => {
  it('tira máscara (ponto/hífen/espaço) → 8 dígitos', () => {
    expect(normalizarCep('35.500-001')).toBe('35500001');
    expect(normalizarCep(' 35500001 ')).toBe('35500001');
    expect(normalizarCep('35500001')).toBe('35500001');
  });

  it('não-8-dígitos → null (PK cep_geo exige exatamente 8)', () => {
    expect(normalizarCep('123')).toBeNull(); // curto
    expect(normalizarCep('355000012')).toBeNull(); // 9 dígitos
    expect(normalizarCep('0000000a')).toBeNull(); // 7 dígitos após strip
  });

  it('vazio/sem-dígito/null/undefined → null (ausente ≠ fabricar)', () => {
    expect(normalizarCep('')).toBeNull();
    expect(normalizarCep('abcdefgh')).toBeNull();
    expect(normalizarCep(null)).toBeNull();
    expect(normalizarCep(undefined)).toBeNull();
  });
});
