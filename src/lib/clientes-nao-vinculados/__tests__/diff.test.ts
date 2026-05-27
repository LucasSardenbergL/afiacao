import { describe, it, expect } from 'vitest';
import { computeNaoVinculados, type OmieClientePagina } from '../diff';

const pagina: OmieClientePagina[] = [
  { codigo_cliente_omie: 100, razao_social: 'A' },
  { codigo_cliente_omie: 200, razao_social: 'B' },
  { codigo_cliente_omie: 300, razao_social: 'C' },
];

describe('computeNaoVinculados', () => {
  it('retorna só os codigos ausentes do set de vinculados', () => {
    const linked = new Set<number>([200]);
    const r = computeNaoVinculados(pagina, linked);
    expect(r.map((c) => c.codigo_cliente_omie)).toEqual([100, 300]);
  });
  it('todos vinculados → []', () => {
    const linked = new Set<number>([100, 200, 300]);
    expect(computeNaoVinculados(pagina, linked)).toEqual([]);
  });
  it('página vazia → []', () => {
    expect(computeNaoVinculados([], new Set())).toEqual([]);
  });
});
