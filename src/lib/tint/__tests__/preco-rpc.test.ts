import { describe, expect, it } from 'vitest';
import { precoDeJson, precosDeJson } from '../preco-rpc';

// Forma real da RPC em prod (pg_get_functiondef, 2026-10-19): custoBase/custoCorantes NULL fora
// do staff; itensCorantes `[]` fora do staff; precoFinal NULL quando base ou corante falta.
const staff = {
  custoBase: 100,
  baseDisponivel: true,
  custoCorantes: 12.5,
  corantesCompletos: true,
  precoFinal: 112.5,
  itensCorantes: [
    { coranteDescricao: 'AXALTA 01', qtdMl: 5, custoPorMl: 2.5, custoItem: 12.5, custoDisponivel: true },
  ],
};

describe('precoDeJson (get_tint_price)', () => {
  it('lê o breakdown do staff por forma', () => {
    expect(precoDeJson(staff)).toEqual(staff);
  });

  it('cliente: custos NULL continuam NULL (não viram 0) e receita vazia', () => {
    const p = precoDeJson({ ...staff, custoBase: null, custoCorantes: null, itensCorantes: [] });
    expect(p.custoBase).toBeNull();
    expect(p.custoCorantes).toBeNull();
    expect(p.precoFinal).toBe(112.5);
    expect(p.itensCorantes).toEqual([]);
  });

  it('fail-closed: precoFinal NULL fica NULL; precoFinal texto LANÇA (nunca Number())', () => {
    expect(precoDeJson({ ...staff, precoFinal: null }).precoFinal).toBeNull();
    expect(() => precoDeJson({ ...staff, precoFinal: '112.5' })).toThrow(/precoFinal/);
    expect(() => precoDeJson({ ...staff, baseDisponivel: 'sim' })).toThrow(/baseDisponivel/);
    expect(() => precoDeJson(null)).toThrow(/não é objeto/);
    expect(() => precoDeJson({ ...staff, itensCorantes: null })).toThrow(/itensCorantes/);
  });

  it('chave AUSENTE não é NULL: resposta sem custoBase/custoCorantes/precoFinal LANÇA', () => {
    const { custoBase: _b, ...semBase } = staff;
    const { custoCorantes: _c, ...semCorantes } = staff;
    const { precoFinal: _p, ...semPreco } = staff;
    expect(() => precoDeJson(semBase)).toThrow(/custoBase ausente/);
    expect(() => precoDeJson(semCorantes)).toThrow(/custoCorantes ausente/);
    expect(() => precoDeJson(semPreco)).toThrow(/precoFinal ausente/);
    expect(() => precosDeJson({ f1: { baseDisponivel: true, corantesCompletos: true, precoFinal: 112.5 } })).toThrow(
      /get_tint_prices\[f1\]: custoBase ausente/,
    );
  });
});

describe('precosDeJson (get_tint_prices)', () => {
  it('mapa por fórmula; `{}` quando vazio', () => {
    const lite = { custoBase: null, baseDisponivel: true, custoCorantes: null, corantesCompletos: false, precoFinal: null };
    expect(precosDeJson({ f1: lite })).toEqual({ f1: lite });
    expect(precosDeJson({})).toEqual({});
  });

  it('entrada fora da forma LANÇA com o id da fórmula', () => {
    expect(() => precosDeJson({ f1: { baseDisponivel: true } })).toThrow(/get_tint_prices\[f1\]: custoBase ausente/);
    expect(() => precosDeJson([])).toThrow(/não é objeto/);
  });
});
