import { describe, it, expect } from 'vitest';
import { montarPrecosLocaisPorConta } from '../precos-por-conta';

/**
 * Regressão money-path: o preço-do-cliente (último praticado) tem de ficar
 * CONFINADO à conta Omie onde foi praticado. Oben e Colacor são contas Omie
 * SEPARADAS cujo `omie_codigo_produto` pode COLIDIR numericamente — achatar os
 * dois espaços de chave num Record só (e injetar nas 2 contas) vaza o preço de
 * uma conta no produto da outra. O `product_id` (uuid de omie_products) JÁ é
 * account-aware; o helper preserva isso separando por `account`.
 */
describe('montarPrecosLocaisPorConta', () => {
  it('colisão cross-account: mesmo omie_codigo_produto em Oben e Colacor → cada conta vê o SEU preço', () => {
    const out = montarPrecosLocaisPorConta(
      { 'uuid-oben': 100, 'uuid-colacor': 150 },
      [
        { id: 'uuid-oben', omie_codigo_produto: 123, account: 'oben' },
        { id: 'uuid-colacor', omie_codigo_produto: 123, account: 'colacor' },
      ],
    );

    expect(out.oben[123]).toBe(100);
    expect(out.colacor[123]).toBe(150);
  });

  it('NÃO contamina: código praticado SÓ em Oben fica AUSENTE do mapa Colacor (ausência por chave)', () => {
    const out = montarPrecosLocaisPorConta(
      { 'uuid-oben': 100 },
      [{ id: 'uuid-oben', omie_codigo_produto: 123, account: 'oben' }],
    );

    expect(out.oben[123]).toBe(100);
    // O flatten antigo injetava o MESMO mapa nas 2 contas → out.colacor[123] === 100.
    // Account-aware: a chave Oben NÃO existe no mapa Colacor — prova ausência por
    // chave (tem dente contra a re-introdução do flatten), não só "valor diferente".
    expect(123 in out.colacor).toBe(false);
    expect(out.colacor).toEqual({});
  });

  it('códigos disjuntos (estado de hoje): cada código cai só na sua conta', () => {
    const out = montarPrecosLocaisPorConta(
      { 'uuid-a': 80, 'uuid-b': 200 },
      [
        { id: 'uuid-a', omie_codigo_produto: 10000000001, account: 'oben' },
        { id: 'uuid-b', omie_codigo_produto: 500, account: 'colacor' },
      ],
    );

    expect(out.oben).toEqual({ 10000000001: 80 });
    expect(out.colacor).toEqual({ 500: 200 });
  });

  it('money-path: preço ausente/0/negativo/NaN NUNCA vira preço (não fabricar)', () => {
    const out = montarPrecosLocaisPorConta(
      {
        'uuid-zero': 0,
        'uuid-neg': -5,
        'uuid-nan': Number.NaN,
        // 'uuid-ausente' propositalmente sem entrada no mapa de preço
        'uuid-ok': 42,
      },
      [
        { id: 'uuid-zero', omie_codigo_produto: 1, account: 'oben' },
        { id: 'uuid-neg', omie_codigo_produto: 2, account: 'oben' },
        { id: 'uuid-nan', omie_codigo_produto: 3, account: 'colacor' },
        { id: 'uuid-ausente', omie_codigo_produto: 4, account: 'colacor' },
        { id: 'uuid-ok', omie_codigo_produto: 5, account: 'oben' },
      ],
    );

    expect(out.oben).toEqual({ 5: 42 });
    expect(out.colacor).toEqual({});
  });

  it('account desconhecido/null → descartado (não vaza pra nenhuma conta)', () => {
    const out = montarPrecosLocaisPorConta(
      { 'uuid-x': 99, 'uuid-y': 77 },
      [
        { id: 'uuid-x', omie_codigo_produto: 7, account: null },
        { id: 'uuid-y', omie_codigo_produto: 8, account: 'colacor_sc' },
      ],
    );

    expect(out.oben).toEqual({});
    expect(out.colacor).toEqual({});
  });

  it('account tolera caixa/espaço divergente (mesma normalização do selo)', () => {
    const out = montarPrecosLocaisPorConta(
      { 'uuid-x': 99 },
      [{ id: 'uuid-x', omie_codigo_produto: 7, account: 'OBEN' }],
    );

    expect(out.oben).toEqual({ 7: 99 });
  });

  it('entrada vazia → mapas vazios por conta (sem throw)', () => {
    expect(montarPrecosLocaisPorConta({}, [])).toEqual({ oben: {}, colacor: {} });
  });
});
