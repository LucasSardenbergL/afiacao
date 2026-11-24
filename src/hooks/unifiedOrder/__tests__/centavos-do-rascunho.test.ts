import { describe, it, expect } from 'vitest';
import { centavosDoRascunho } from '../centavos-do-rascunho';

describe('centavosDoRascunho — rascunho antigo volta ao centavo', () => {
  it('produto comum: unit_price e precoNascimento ao centavo, igualdade preservada', () => {
    const [it] = centavosDoRascunho([{ type: 'product', quantity: 2, unit_price: 12.3456, precoNascimento: 12.3456 }]) as Array<
      Record<string, unknown>
    >;
    expect(it.unit_price).toBe(12.35);
    expect(it.precoNascimento).toBe(12.35);
    expect(it.unit_price === it.precoNascimento).toBe(true);
  });

  it('produto editado à mão (sem igualdade) também vai ao centavo, e segue "editado"', () => {
    const [it] = centavosDoRascunho([{ type: 'product', unit_price: 9.999, precoNascimento: 12.3456 }]) as Array<
      Record<string, unknown>
    >;
    expect(it.unit_price).toBe(10);
    expect(it.precoNascimento).toBe(12.35);
  });

  it('tint fica intocado (regra própria; 2ª passada divergiria)', () => {
    const tint = { type: 'product', unit_price: 33.335, tint_cor_id: 'c1', tint_formula_id: 'f1' };
    expect(centavosDoRascunho([tint])[0]).toBe(tint);
    const soCor = { type: 'product', unit_price: 33.335, tint_cor_id: 'c1' };
    expect(centavosDoRascunho([soCor])[0]).toBe(soCor);
  });

  it('serviço e lixo passam como vieram; preço não numérico não vira 0', () => {
    const servico = { type: 'service', quantity: 1 };
    const semPreco = { type: 'product', unit_price: 'abc' };
    const out = centavosDoRascunho([servico, null, 7, semPreco]);
    expect(out[0]).toBe(servico);
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(7);
    expect((out[3] as Record<string, unknown>).unit_price).toBe('abc');
  });
});
