import { describe, it, expect } from 'vitest';
import { mapItemsToPickingRows, deriveParentStatus } from './bridge-helpers';

describe('mapItemsToPickingRows', () => {
  it('mapeia itens inteiros', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 12, descricao: 'X', quantidade: 3 }]);
    expect(r.rows).toEqual([{ omie_codigo_produto: 12, product_descricao: 'X', quantidade: 3 }]);
    expect(r.fractionalNotes).toHaveLength(0);
    expect(r.badCount).toBe(0);
  });

  it('ceil + nota em fracionário', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 7, descricao: 'Y', quantidade: 1.5 }]);
    expect(r.rows[0].quantidade).toBe(2);
    expect(r.fractionalNotes[0]).toContain('1.5');
    expect(r.fractionalNotes[0]).toContain('2');
  });

  it('quantidade ≤ 0 e fracionária negativa são ignoradas (não viram linha, não são bad)', () => {
    const r = mapItemsToPickingRows([
      { omie_codigo_produto: 1, quantidade: 0 },
      { omie_codigo_produto: 2, quantidade: -3 },
      { omie_codigo_produto: 3, quantidade: -1.5 },
    ]);
    expect(r.rows).toHaveLength(0);
    expect(r.fractionalNotes).toHaveLength(0);
    expect(r.badCount).toBe(0);
  });

  it('quantidade inválida (string não-numérica/null/ausente) e item null → badCount, pula', () => {
    const r = mapItemsToPickingRows([{ quantidade: 'abc' }, { quantidade: null }, { descricao: 'sem qtd' }, null]);
    expect(r.rows).toHaveLength(0);
    expect(r.badCount).toBe(4);
  });

  it('string numérica (com espaços) é aceita', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 9, descricao: 'S', quantidade: ' 2 ' }]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ omie_codigo_produto: 9, product_descricao: 'S', quantidade: 2 });
    expect(r.badCount).toBe(0);
  });

  it('código textual / 0 → omie_codigo_produto null, ainda vira linha; descricao null → ""', () => {
    const r = mapItemsToPickingRows([
      { omie_codigo_produto: 'AB12', descricao: null, quantidade: 1 },
      { omie_codigo_produto: 0, descricao: 'Z', quantidade: 1 },
    ]);
    expect(r.rows[0]).toEqual({ omie_codigo_produto: null, product_descricao: '', quantidade: 1 });
    expect(r.rows[1].omie_codigo_produto).toBeNull();
  });

  it('items não-array → vazio', () => {
    expect(mapItemsToPickingRows(null).rows).toHaveLength(0);
    expect(mapItemsToPickingRows({} as unknown).rows).toHaveLength(0);
    expect(mapItemsToPickingRows('x' as unknown).badCount).toBe(0);
  });
});

describe('deriveParentStatus', () => {
  it('nada separado → pendente', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 0 }]).status).toBe('pendente');
  });
  it('parcial → em_andamento', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 2 }]).status).toBe('em_andamento');
  });
  it('tudo separado → concluido', () => {
    expect(
      deriveParentStatus([
        { quantidade: 5, quantidade_separada: 5 },
        { quantidade: 2, quantidade_separada: 2 },
      ]).status,
    ).toBe('concluido');
  });
  it('separado além do esperado → concluido', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 6 }]).status).toBe('concluido');
  });
  it('lista vazia → pendente', () => {
    expect(deriveParentStatus([]).status).toBe('pendente');
  });
});
