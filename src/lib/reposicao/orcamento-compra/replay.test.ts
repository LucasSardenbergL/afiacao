// src/lib/reposicao/orcamento-compra/replay.test.ts
import { describe, expect, it } from 'vitest';
import { classificarCorte, replaySku } from './replay';
import { deduplicarEpisodios, deltaDio, precisaoDoCorte } from './medicao';

describe('replay contrafactual (spec §8 teste 11)', () => {
  it('compra que evitou a ruptura: saldo mínimo 4 com a compra; sem os 12 cortados rompe', () => {
    const entrada = { estoqueInicial: 0, demanda: [4, 4, 4, 4], recebimentos: [{ dia: 0, qtde: 20 }], politica: null };
    const com = replaySku({ ...entrada, removido: null });
    const sem = replaySku({ ...entrada, removido: { dia: 0, qtde: 12 } });
    expect(com.rompeu).toBe(false);
    expect(sem.rompeu).toBe(true);
    expect(sem.primeiroDiaRuptura).toBe(2);
    expect(sem.unidadesPerdidas).toBe(8); // dias 2 e 3 perdem 4 cada (conta à mão; o brief dizia 4)
    expect(com.unidadesPerdidas).toBe(0);
    expect(classificarCorte(com, sem)).toBe('teria_rompido');
  });
  it('com política própria o corte é recomprado a tempo → adiado', () => {
    const entrada = { estoqueInicial: 10, demanda: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], recebimentos: [{ dia: 0, qtde: 5 }], politica: { pontoPedido: 6, leadTimeDias: 2 } };
    const com = replaySku({ ...entrada, removido: null, politica: null });
    const sem = replaySku({ ...entrada, removido: { dia: 0, qtde: 5 } });
    expect(sem.reposicaoPropria).toBe(true);
    expect(classificarCorte(com, sem)).toBe('adiado');
  });
  it('sobra sem recompra e sem ruptura → eliminado', () => {
    const entrada = { estoqueInicial: 50, demanda: [1, 1, 1], recebimentos: [{ dia: 0, qtde: 5 }], politica: null };
    expect(classificarCorte(replaySku({ ...entrada, removido: null }), replaySku({ ...entrada, removido: { dia: 0, qtde: 5 } }))).toBe('eliminado');
  });
  it('dia censurado no período → indeterminado', () => {
    const entrada = { estoqueInicial: 5, demanda: [1, null, 1], recebimentos: [], politica: null };
    expect(classificarCorte(replaySku({ ...entrada, removido: null }), replaySku({ ...entrada, removido: null }))).toBe('indeterminado');
  });
});

describe('déficit da remoção e semântica (R16–R18)', () => {
  it('déficit da remoção persiste até o recebimento cobrir', () => {
    const entrada = { estoqueInicial: 0, demanda: [0, 4, 4, 4], recebimentos: [{ dia: 1, qtde: 20 }], politica: null };
    const com = replaySku({ ...entrada, removido: null });
    const sem = replaySku({ ...entrada, removido: { dia: 0, qtde: 12 } });
    expect(com.rompeu).toBe(false);
    expect(sem.rompeu).toBe(true);
    expect(sem.primeiroDiaRuptura).toBe(3);
    expect(sem.unidadesPerdidas).toBe(4);
    expect(classificarCorte(com, sem)).toBe('teria_rompido');
  });
  it('demanda 0 com estoque negativo nunca marca ruptura', () => {
    const r = replaySku({ estoqueInicial: 0, demanda: [0, 0], recebimentos: [], removido: { dia: 0, qtde: 12 }, politica: null });
    expect(r.rompeu).toBe(false);
    expect(r.primeiroDiaRuptura).toBeNull();
  });
  it('estoque parcial: vende o que tem e perde o resto', () => {
    const r = replaySku({ estoqueInicial: 2, demanda: [4], recebimentos: [], removido: null, politica: null });
    expect(r.unidadesPerdidas).toBe(2);
    expect(r.estoqueFinal).toBe(0);
  });
  it('ponto de pedido já cruzado ANTES da remoção: reposição própria só a partir da remoção e uma vez', () => {
    const r = replaySku({ estoqueInicial: 5, demanda: [1, 1, 1, 1, 1], recebimentos: [], removido: { dia: 2, qtde: 3 }, politica: { pontoPedido: 6, leadTimeDias: 1 } });
    expect(r.reposicaoPropria).toBe(true);
    expect(r.primeiroDiaRuptura).toBe(2);
    expect(r.estoqueFinal).toBe(1); // 5 - 3 + 3 (uma vez) - 4 vendidas
  });
  it('lead time fracionário arredonda para cima (2,5 -> chega no dia t+3)', () => {
    const r = replaySku({ estoqueInicial: 3, demanda: [1, 1, 1, 1, 1], recebimentos: [], removido: { dia: 0, qtde: 1 }, politica: { pontoPedido: 3, leadTimeDias: 2.5 } });
    expect(r.primeiroDiaRuptura).toBe(2);
    expect(r.unidadesPerdidas).toBe(2);
  });
  it('demanda NaN ou estoque inicial não finito => indeterminado', () => {
    const base = { recebimentos: [], removido: null, politica: null };
    expect(replaySku({ ...base, estoqueInicial: 5, demanda: [1, Number.NaN] }).indeterminado).toBe(true);
    expect(replaySku({ ...base, estoqueInicial: Number.NaN, demanda: [1] }).indeterminado).toBe(true);
  });
  it('série vazia => estoqueMedio null', () => {
    expect(replaySku({ estoqueInicial: 5, demanda: [], recebimentos: [], removido: null, politica: null }).estoqueMedio).toBeNull();
  });
  it('diferença de 1e-16 não é teria_rompido', () => {
    const mk = (u: number) => ({ rompeu: u > 0, primeiroDiaRuptura: null, unidadesPerdidas: u, indeterminado: false, estoqueMedio: 1, estoqueFinal: 1, reposicaoPropria: false });
    expect(classificarCorte(mk(0), mk(1e-16))).toBe('eliminado');
  });
});

describe('censura domina', () => {
  it('período com dia censurado é indeterminado mesmo que o cenário sem os cortados rompa', () => {
    const entrada = { estoqueInicial: 0, demanda: [4, null, 4, 4], recebimentos: [{ dia: 0, qtde: 20 }], politica: null };
    const com = replaySku({ ...entrada, removido: null });
    const sem = replaySku({ ...entrada, removido: { dia: 0, qtde: 12 } });
    expect(sem.rompeu).toBe(true);
    expect(classificarCorte(com, sem)).toBe('indeterminado');
  });
});

describe('medição', () => {
  it('mesma necessidade em ciclos seguidos conta 1 episódio (valor máximo, não soma)', () => {
    const e = deduplicarEpisodios(
      [
        { sku: 'A', data: '2026-10-01', valor: 100 },
        { sku: 'A', data: '2026-10-02', valor: 120 },
        { sku: 'A', data: '2026-10-20', valor: 50 },
        { sku: 'B', data: '2026-10-02', valor: 10 },
      ],
      7,
    );
    expect(e).toEqual([
      { sku: 'A', inicio: '2026-10-01', fim: '2026-10-02', valor: 120 },
      { sku: 'A', inicio: '2026-10-20', fim: '2026-10-20', valor: 50 },
      { sku: 'B', inicio: '2026-10-02', fim: '2026-10-02', valor: 10 },
    ]);
  });
  it('gap exatamente igual a gapDias funde', () => {
    const e = deduplicarEpisodios([{ sku: 'A', data: '2026-10-01', valor: 5 }, { sku: 'A', data: '2026-10-08', valor: 9 }], 7);
    expect(e).toEqual([{ sku: 'A', inicio: '2026-10-01', fim: '2026-10-08', valor: 9 }]);
  });
  it('precisão = R$ sem ruptura / R$ cortado, indeterminados fora do denominador', () => {
    const r = precisaoDoCorte([
      { classe: 'eliminado', valor: 60 }, { classe: 'adiado', valor: 20 }, { classe: 'teria_rompido', valor: 20 }, { classe: 'indeterminado', valor: 999 },
    ]);
    expect(r).toEqual({ precisao: 0.8, valorCortado: 100, n: 3, indeterminados: 1 });
  });
  it('zero corte → precisão não aplicável (null), nunca 100%', () => {
    expect(precisaoDoCorte([]).precisao).toBeNull();
  });
  it('ΔDIO = Δ estoque médio a custo / CMV diário; CMV ausente → null', () => {
    expect(deltaDio(600, 500, 10)).toBe(10);
    expect(deltaDio(600, 500, null)).toBeNull();
    expect(deltaDio(600, 500, 0)).toBeNull();
  });
});
