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

describe('normalizarDocumento: CNPJ alfanumérico (RFB jul/2026) — a mesma chave de v_caca_* (migration 20261020130000)', () => {
  it('exemplo oficial da RFB preserva as letras, em maiúsculas', () => {
    expect(normalizarDocumento('12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(normalizarDocumento('12ABC34501DE35')).toBe('12ABC34501DE35');
  });
  it('DV errado cai nos dígitos (não se fabrica documento)', () => {
    expect(normalizarDocumento('12.ABC.345/01DE-36')).toBe('123450136');
  });
});
