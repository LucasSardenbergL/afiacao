import { describe, it, expect } from 'vitest';
import { normalizarDocumento } from '../documento';

describe('normalizarDocumento', () => {
  it('remove máscara de CNPJ', () => {
    expect(normalizarDocumento('12.345.678/0001-90')).toBe('12345678000190');
  });

  it('remove máscara de CPF', () => {
    expect(normalizarDocumento('123.456.789-09')).toBe('12345678909');
  });

  it('já normalizado, sem modificação', () => {
    expect(normalizarDocumento('12345678000190')).toBe('12345678000190');
  });

  it('null retorna string vazia', () => {
    expect(normalizarDocumento(null)).toBe('');
  });

  it('string vazia retorna string vazia', () => {
    expect(normalizarDocumento('')).toBe('');
  });

  it('apenas letras retorna string vazia', () => {
    expect(normalizarDocumento('abc')).toBe('');
  });

  it('letras misturadas com dígitos → só dígitos', () => {
    expect(normalizarDocumento('12abc34')).toBe('1234');
  });

  it('espaços são removidos', () => {
    expect(normalizarDocumento('12 345')).toBe('12345');
  });
});
