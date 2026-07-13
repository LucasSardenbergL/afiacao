import { describe, it, expect } from 'vitest';
import { mapFunilRow } from '../funil';

describe('mapFunilRow (row da RPC get_whatsapp_funil → WaFunil)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    enviados: 4,
    entregues: 3,
    lidos: 1,
    falhas: 1,
    respondidos: 1,
    propostas: 2,
    pedidos_omie: 1,
    receita_omie: '1000.50', // numeric do PostgREST chega como string
    ...over,
  });

  it('converte counts e receita (string numérica → number)', () => {
    const f = mapFunilRow(row());
    expect(f).toEqual({
      enviados: 4, entregues: 3, lidos: 1, falhas: 1,
      respondidos: 1, propostas: 2, pedidosOmie: 1, receitaOmie: 1000.5,
    });
  });

  it('receita null PERMANECE null (ausente ≠ zero — nunca fabricar R$ 0)', () => {
    const f = mapFunilRow(row({ receita_omie: null }));
    expect(f?.receitaOmie).toBeNull();
  });

  it('shape inválido vira null, não crash nem números fabricados', () => {
    expect(mapFunilRow(null)).toBeNull();
    expect(mapFunilRow('erro')).toBeNull();
    expect(mapFunilRow(row({ enviados: 'não-é-número' }))).toBeNull();
  });
});
