import { describe, it, expect } from 'vitest';
import { hrefTelefone } from './telefone';

describe('hrefTelefone', () => {
  it('formatação some, dígitos ficam', () => {
    expect(hrefTelefone('(37) 99876-5432')).toBe('tel:37998765432');
    expect(hrefTelefone('+55 37 3221-0000')).toBe('tel:+553732210000');
  });
  it('ausente ou curto demais → null (sem link que disca lixo)', () => {
    expect(hrefTelefone(null)).toBeNull();
    expect(hrefTelefone('')).toBeNull();
    expect(hrefTelefone('ramal 12')).toBeNull();
  });
});
