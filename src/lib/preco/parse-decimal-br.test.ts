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

  it('interpreta corretamente formato en-US (vírgula milhar + ponto decimal)', () => {
    // o ÚLTIMO separador é o decimal — antes virava 1.23456 (subprecificação 1000x)
    expect(parseDecimalBR('1,234.56')).toBe(1234.56);
    expect(parseDecimalBR('1,234,567')).toBe(1234567);
  });

  it('aceita milhar pt-BR completo', () => {
    expect(parseDecimalBR('1.234.567,89')).toBe(1234567.89);
  });

  it('REJEITA agrupamento ambíguo em vez de fabricar preço errado (money-path)', () => {
    // "1.234" em pt-BR normalmente é 1234; como decimal seria 1.234 — ambíguo → null
    expect(parseDecimalBR('1.234')).toBeNull();
    expect(parseDecimalBR('12.345')).toBeNull();
    // grupos de milhar mal formados também são rejeitados
    expect(parseDecimalBR('1,23.456')).toBeNull();
  });

  it('NÃO rejeita decimal legítimo com 3 casas quando não parece milhar', () => {
    expect(parseDecimalBR('0,999')).toBe(0.999);
    expect(parseDecimalBR('0.999')).toBe(0.999); // inteiro "0" não é grupo de milhar válido
  });
});
