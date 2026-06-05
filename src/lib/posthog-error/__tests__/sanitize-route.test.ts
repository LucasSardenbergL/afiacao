import { describe, it, expect } from 'vitest';
import { stripQueryString } from '../sanitize-route';

describe('stripQueryString', () => {
  it('remove query string (que pode ter PII)', () => {
    expect(stripQueryString('/clientes/123?cpf=99999999999&nome=Joao')).toBe('/clientes/123');
  });
  it('remove fragmento', () => {
    expect(stripQueryString('/rota/x#secao')).toBe('/rota/x');
  });
  it('mantém path puro', () => {
    expect(stripQueryString('/financeiro/cockpit')).toBe('/financeiro/cockpit');
  });
  it('string vazia → vazia', () => {
    expect(stripQueryString('')).toBe('');
  });
  it('corta no primeiro de ? ou #', () => {
    expect(stripQueryString('/a?b#c')).toBe('/a');
    expect(stripQueryString('/a#b?c')).toBe('/a');
  });
});
