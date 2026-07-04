import { describe, it, expect } from 'vitest';
import { parseDecimalBR } from './parse-decimal-br';

describe('parseDecimalBR', () => {
  it('aceita vírgula como separador decimal (teclado pt-BR)', () => {
    expect(parseDecimalBR('12,5')).toBe(12.5);
    expect(parseDecimalBR('0,99')).toBe(0.99);
  });

  it('aceita ponto como separador decimal', () => {
    expect(parseDecimalBR('12.5')).toBe(12.5);
  });

  it('trata ponto como milhar quando há vírgula decimal', () => {
    expect(parseDecimalBR('1.234,56')).toBe(1234.56);
    expect(parseDecimalBR('1.000,00')).toBe(1000);
  });

  it('aceita inteiro sem separador', () => {
    expect(parseDecimalBR('1234')).toBe(1234);
  });

  it('retorna null para vazio ou lixo (não fabrica zero)', () => {
    expect(parseDecimalBR('')).toBeNull();
    expect(parseDecimalBR('   ')).toBeNull();
    expect(parseDecimalBR('abc')).toBeNull();
    expect(parseDecimalBR('12,5,6')).toBeNull();
  });
});
