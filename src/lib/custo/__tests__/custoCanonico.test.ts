import { describe, it, expect } from 'vitest';
import { custoValido, custoCanonico } from '@/lib/custo/custoCanonico';

describe('custoValido — ausente≠zero', () => {
  it('aceita número positivo finito', () => {
    expect(custoValido(12.5)).toBe(12.5);
  });
  it('converte string numérica', () => {
    expect(custoValido('12.5')).toBe(12.5);
  });
  it('rejeita 0, negativo, NaN, Infinity, null, undefined, string vazia → null (NUNCA 0)', () => {
    for (const x of [0, -3, NaN, Infinity, null, undefined, '', 'abc'] as const) {
      expect(custoValido(x)).toBeNull();
    }
  });
});

describe('custoCanonico — cost_final preferido, fallback cost_price real', () => {
  it('usa cost_final quando válido', () => {
    expect(custoCanonico({ cost_final: 8, cost_price: 5 })).toBe(8);
  });
  it('cai para cost_price quando cost_final é ausente/inválido', () => {
    expect(custoCanonico({ cost_final: null, cost_price: 5 })).toBe(5);
    expect(custoCanonico({ cost_final: 0, cost_price: 5 })).toBe(5);
  });
  it('null quando AMBOS ausentes/inválidos (SKU sem custo → excluir, não margem 100%)', () => {
    expect(custoCanonico({ cost_final: null, cost_price: null })).toBeNull();
    expect(custoCanonico({ cost_final: 0, cost_price: 0 })).toBeNull();
    expect(custoCanonico({})).toBeNull();
  });
});
