import { describe, it, expect } from 'vitest';
import { filtrarCestaPorAtivos } from './cesta-ativos';
import type { CestaItem, CestaResult } from './cesta-recompra';

function item(sku: number): CestaItem {
  return {
    omie_codigo_produto: sku, qtdSugerida: 2, dueRatio: 1, nPedidos: 3, cadenciaDias: 30,
    confidence: 'media', motivo: 'recorrente_due', ultimoPrecoRef: 10,
  };
}
function cesta(principal: number[], secundarios: number[]): CestaResult {
  return {
    principal: principal.map(item), secundarios: secundarios.map(item),
    totalPedidos: 5, confianca: 'media',
  };
}

describe('filtrarCestaPorAtivos', () => {
  it('remove SKU inativo da principal e dos secundários (codex P1: não propor SKU morto)', () => {
    const r = filtrarCestaPorAtivos(cesta([100, 200], [300, 400]), new Set([100, 300]));
    expect(r.cesta.principal.map(i => i.omie_codigo_produto)).toEqual([100]);
    expect(r.cesta.secundarios.map(i => i.omie_codigo_produto)).toEqual([300]);
    expect(r.removidos).toBe(2); // 200 e 400 inativos
  });
  it('mantém todos quando todos ativos', () => {
    const r = filtrarCestaPorAtivos(cesta([100, 200], []), new Set([100, 200]));
    expect(r.cesta.principal.length).toBe(2);
    expect(r.removidos).toBe(0);
  });
  it('todos inativos → cesta vazia, removidos = total', () => {
    const r = filtrarCestaPorAtivos(cesta([100], [200, 300]), new Set<number>());
    expect(r.cesta.principal).toEqual([]);
    expect(r.cesta.secundarios).toEqual([]);
    expect(r.removidos).toBe(3);
  });
  it('preserva totalPedidos e confianca', () => {
    const r = filtrarCestaPorAtivos(cesta([100], []), new Set([100]));
    expect(r.cesta.totalPedidos).toBe(5);
    expect(r.cesta.confianca).toBe('media');
  });
});
