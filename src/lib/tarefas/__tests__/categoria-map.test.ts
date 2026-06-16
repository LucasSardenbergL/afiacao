import { describe, it, expect } from 'vitest';
import { autoSatisfyDaCategoria } from '../categoria-map';

describe('autoSatisfyDaCategoria', () => {
  it('ligar → interacao', () => expect(autoSatisfyDaCategoria('ligar')).toBe('interacao'));
  it('oferecer/preco → conteudo', () => {
    expect(autoSatisfyDaCategoria('oferecer')).toBe('conteudo');
    expect(autoSatisfyDaCategoria('preco')).toBe('conteudo');
  });
  it('whatsapp/outro → off', () => {
    expect(autoSatisfyDaCategoria('whatsapp')).toBe('off');
    expect(autoSatisfyDaCategoria('outro')).toBe('off');
  });
});
