import { describe, expect, it } from 'vitest';
import { anulavel, campo, lista, numero, objeto, opcional, registro, texto, uniao } from './borda-json';

describe('borda-json: leitores por forma', () => {
  it('número é número de verdade: string numérica e NULL lançam (nada de Number(v))', () => {
    expect(numero(0, 'x')).toBe(0);
    expect(numero(-12.5, 'x')).toBe(-12.5);
    expect(() => numero('12', 'x.v')).toThrow('x.v: esperava número, veio string');
    expect(() => numero(null, 'x.v')).toThrow('x.v: esperava número, veio null');
    expect(() => numero(undefined, 'x.v')).toThrow('x.v: esperava número, veio ausente');
  });

  it('objeto recusa array e null', () => {
    expect(objeto({ a: 1 }, 'o')).toEqual({ a: 1 });
    expect(() => objeto([1], 'o')).toThrow('o: esperava objeto, veio array');
    expect(() => objeto(null, 'o')).toThrow('o: esperava objeto, veio null');
  });

  it('anulavel deixa passar NULL explícito, mas não chave ausente', () => {
    expect(anulavel(texto)(null, 'm')).toBeNull();
    expect(anulavel(texto)('ok', 'm')).toBe('ok');
    expect(() => anulavel(texto)(undefined, 'm')).toThrow('m: esperava texto, veio ausente');
  });

  it('lista e registro apontam o elemento ruim no caminho', () => {
    expect(lista(texto)(['a', 'b'], 'l')).toEqual(['a', 'b']);
    expect(() => lista(texto)(['a', 2], 'l')).toThrow('l[1]: esperava texto, veio number');
    expect(registro(numero)({ '2.01': 10 }, 'r')).toEqual({ '2.01': 10 });
    expect(() => registro(numero)({ '2.01': '10' }, 'r')).toThrow('r.2.01: esperava número, veio string');
  });

  it('uniao lança fora do vocabulário, nomeando o valor', () => {
    expect(uniao(['a', 'b'])('a', 'u')).toBe('a');
    expect(() => uniao(['a', 'b'])('c', 'u')).toThrow('u: valor fora do vocabulário "c" (aceitos: a|b)');
  });

  it('campo obrigatório ausente lança', () => {
    expect(() => campo({}, 'k', numero, 'o')).toThrow('o.k: esperava número, veio ausente');
  });

  it('opcional ausente continua AUSENTE (sem `undefined` explícito que apagaria default num spread)', () => {
    const out: { k?: number; n?: string | null } = {};
    opcional(out, {}, 'k', numero, 'o');
    expect('k' in out).toBe(false);
    expect({ ...{ k: 7 }, ...out }.k).toBe(7);
    opcional(out, { n: null }, 'n', anulavel(texto), 'o');
    expect(out).toEqual({ n: null });
    expect(() => opcional(out, { k: 'x' }, 'k', numero, 'o')).toThrow('o.k: esperava número, veio string');
  });
});
