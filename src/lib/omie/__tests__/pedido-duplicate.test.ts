import { describe, it, expect } from 'vitest';
import { isOmieDuplicatePedido } from '../pedido-duplicate';
describe('isOmieDuplicatePedido', () => {
  it('Error com "já cadastrado"', () => { expect(isOmieDuplicatePedido(new Error('Pedido já cadastrado p/ o código de integração'))).toBe(true); });
  it('Error "ja cadastrado" sem acento', () => { expect(isOmieDuplicatePedido(new Error('codigo de integracao ja cadastrado'))).toBe(true); });
  it('string crua também', () => { expect(isOmieDuplicatePedido('integração já cadastrada')).toBe(true); });
  it('outro erro → false', () => { expect(isOmieDuplicatePedido(new Error('Cliente não encontrado'))).toBe(false); });
  it('null/forma inesperada → false', () => {
    expect(isOmieDuplicatePedido(null)).toBe(false);
    expect(isOmieDuplicatePedido({})).toBe(false);
  });
});
