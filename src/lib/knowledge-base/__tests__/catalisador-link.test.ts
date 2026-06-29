import { describe, it, expect } from 'vitest';
import { normalizarCatalisador, keyDeCatalisador } from '../catalisador-link';

describe('normalizarCatalisador (espelha o SQL kb_normalizar_catalisador)', () => {
  it('UPPER + tira separadores → consolida variantes', () => {
    expect(normalizarCatalisador('FC.6975')).toBe('FC6975');
    expect(normalizarCatalisador('FC 6975')).toBe('FC6975'); // variante de espaço
    expect(normalizarCatalisador('fc.6975')).toBe('FC6975'); // minúsculo
    expect(normalizarCatalisador('FC.5202.RA')).toBe('FC5202RA');
  });

  it('vazio/whitespace/null/undefined → ""', () => {
    expect(normalizarCatalisador('')).toBe('');
    expect(normalizarCatalisador('   ')).toBe('');
    expect(normalizarCatalisador(null)).toBe('');
    expect(normalizarCatalisador(undefined)).toBe('');
  });

  it('multi-código/free-text normaliza pra algo que não casa SKU (degrada a sob consulta)', () => {
    expect(normalizarCatalisador('FC.6930 ou FC.7090')).toBe('FC6930OUFC7090');
  });
});

describe('keyDeCatalisador', () => {
  it('chave estável (norm|conta minúscula)', () => {
    expect(keyDeCatalisador('FC6975', 'colacor')).toBe('FC6975|colacor');
    expect(keyDeCatalisador('FC6975', 'OBEN')).toBe('FC6975|oben');
  });
});
