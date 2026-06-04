import { describe, it, expect } from 'vitest';
import { rankearFila, dedupe } from '../ranking';
import type { AcaoSugerida } from '../types';

function acao(p: Partial<AcaoSugerida>): AcaoSugerida {
  return {
    fonte: 'mixgap', entidadeId: 'x', clienteUserId: 'c1', clienteNome: 'C1', telefone: null,
    acao: 'Oferecer', titulo: 't', motivo: 'm', categoria: 'esperado', score: 0.5,
    valorEsperado: null, tipoValor: 'estimado', cta: 'pedido', dedupeKey: 'c1:pedido', ...p,
  };
}

describe('rankearFila', () => {
  it('coloca prazo acima de esperado mesmo com valorEsperado alto no esperado', () => {
    const fila = rankearFila([
      acao({ categoria: 'esperado', valorEsperado: 9999, dedupeKey: 'a' }),
      acao({ categoria: 'prazo', valorEsperado: null, dedupeKey: 'b' }),
    ]);
    expect(fila[0].categoria).toBe('prazo');
  });

  it('dentro da mesma categoria, maior valorEsperado primeiro; null por último', () => {
    const fila = rankearFila([
      acao({ categoria: 'esperado', valorEsperado: null, dedupeKey: 'a' }),
      acao({ categoria: 'esperado', valorEsperado: 500, dedupeKey: 'b' }),
      acao({ categoria: 'esperado', valorEsperado: 1500, dedupeKey: 'c' }),
    ]);
    expect(fila.map(a => a.valorEsperado)).toEqual([1500, 500, null]);
  });

  it('desempata por score quando valorEsperado é igual', () => {
    const fila = rankearFila([
      acao({ categoria: 'prazo', valorEsperado: null, score: 0.3, dedupeKey: 'a' }),
      acao({ categoria: 'prazo', valorEsperado: null, score: 0.9, dedupeKey: 'b' }),
    ]);
    expect(fila[0].score).toBe(0.9);
  });

  it('é estável e não muta a entrada', () => {
    const entrada = [acao({ dedupeKey: 'a' }), acao({ dedupeKey: 'b' })];
    const copia = [...entrada];
    rankearFila(entrada);
    expect(entrada).toEqual(copia);
  });
});

describe('dedupe', () => {
  it('mantém só a ação de maior prioridade por dedupeKey', () => {
    const out = dedupe([
      acao({ categoria: 'esperado', dedupeKey: 'c1:ligar' }),
      acao({ categoria: 'prazo', dedupeKey: 'c1:ligar' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].categoria).toBe('prazo');
  });

  it('não colapsa dedupeKeys diferentes', () => {
    const out = dedupe([acao({ dedupeKey: 'a' }), acao({ dedupeKey: 'b' })]);
    expect(out).toHaveLength(2);
  });
});
