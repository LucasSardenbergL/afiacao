import { describe, expect, it } from 'vitest';
import { filaTop, linhasForaDoEstoque, proximoDaFila } from '../fila';
import { classificar } from '../classificar';
import type { CoorteTop, ItemRaioX } from '../tipos';
import { decisao, fato, HOJE, mapaDecisoes } from './fixtures';

const item = (sku: number, valor: number | null, o: Partial<ItemRaioX> = {}): ItemRaioX => ({
  ...classificar([fato({ sku_codigo_omie: sku })], new Map(), 'oben', HOJE)[0],
  valor, top: true, ...o,
});
const coorte = (...ms: Array<[number, number | null]>): CoorteTop => ({
  congelada_em: '2026-11-01T00:00:00Z',
  itens: new Map(ms.map(([sku, valor], i) => [sku, { posicao: i + 1, valor }])),
});

describe('filaTop', () => {
  it('só pendentes do Top, por R$ desc; sem custo no fim; fora do Top fica de fora', () => {
    const f = filaTop(
      [item(1, 100), item(2, 300), item(3, null), item(4, 200, { top: false }), item(5, 250)],
      mapaDecisoes(decisao(5, { destino: 'trocar' })),
    );
    expect(f.map((i) => i.sku_codigo_omie)).toEqual([2, 1, 3]);
  });
  it('linha histórica (saiu do estoque) entra pelo valor da coorte', () => {
    const [h] = linhasForaDoEstoque(coorte([9, 150]), new Set(), new Map());
    const f = filaTop([item(1, 100), item(2, 300), h], new Map());
    expect(f.map((i) => i.sku_codigo_omie)).toEqual([2, 9, 1]);
  });
  it('linha sem destino (só contagem) segue pendente', () => {
    expect(filaTop([item(1, 100)], mapaDecisoes(decisao(1, { qtd_contada: 3 }))).length).toBe(1);
  });
});

describe('proximoDaFila', () => {
  const fila = [{ sku_codigo_omie: 10 }, { sku_codigo_omie: 20 }, { sku_codigo_omie: 30 }];
  it('começo da fila sem atual', () => expect(proximoDaFila(fila, null, new Set())).toBe(10));
  it('o seguinte ao atual', () => expect(proximoDaFila(fila, 10, new Set())).toBe(20));
  it('circular: depois do último volta ao começo (o "Pular" não acaba a fila)', () => expect(proximoDaFila(fila, 30, new Set())).toBe(10));
  it('pula os já salvos nesta sessão (refetch ainda não voltou)', () => expect(proximoDaFila(fila, 10, new Set([20]))).toBe(30));
  it('atual que já saiu da fila (salvo e refetch voltou): o primeiro restante', () =>
    expect(proximoDaFila([{ sku_codigo_omie: 20 }, { sku_codigo_omie: 30 }], 10, new Set([10]))).toBe(20));
  it('fila zerada → null', () => {
    expect(proximoDaFila(fila, 10, new Set([20, 30]))).toBeNull();
    expect(proximoDaFila([], null, new Set())).toBeNull();
  });
});

describe('linhasForaDoEstoque (bug 2)', () => {
  it('membro da coorte fora dos fatos vira linha decidível, com a foto da coorte e sem R$ de hoje', () => {
    const ls = linhasForaDoEstoque(coorte([1, 500], [2, 300]), new Set([1]), new Map([[2, { codigo: 'C2', descricao: 'VERNIZ' }]]));
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({
      sku_codigo_omie: 2, codigo: 'C2', descricao: 'VERNIZ', saldo: 0, valor: null, valor_coorte: 300,
      fora_do_estoque: true, top: true, parado: true, categoria: 'mercadoria', destino_sugerido: null, no_motor: false,
    });
  });
  it('sem cadastro: nasce com o nº do SKU (o nome nunca some a linha)', () => {
    expect(linhasForaDoEstoque(coorte([7, null]), new Set(), new Map())[0]).toMatchObject({ codigo: '7', descricao: null, valor_coorte: null });
  });
  it('sem coorte congelada: nada', () => expect(linhasForaDoEstoque(null, new Set(), new Map())).toEqual([]));
});
