import { describe, expect, it } from 'vitest';
import type { ItemBacktest } from './dados';
import { ORDENS, planejarChamadas, chaveDaChamada } from './rodar';

const item = (id: string): ItemBacktest => ({
  id,
  dominio: 'categoria_dre',
  grupo: id,
  tipoGabarito: 'seed',
  state: { categoria: 'x' },
  instrucoes: 'q',
  opcoes: [
    { chave: 'a', descricao: null },
    { chave: 'b', descricao: 'B' },
    { chave: 'nenhuma', descricao: null },
  ],
  gabarito: ['a'],
  baseline: null,
});

describe('planejarChamadas — 3 chamadas por item: direta, invertida e repetida', () => {
  it('as três ordens, com as opções na ordem de cada uma', () => {
    const plano = planejarChamadas([item('i1')], new Set());
    expect(ORDENS).toEqual(['direta', 'invertida', 'repetida']);
    expect(plano.map((c) => c.ordem)).toEqual(['direta', 'invertida', 'repetida']);
    expect(plano[0].pergunta.criteria.map(([k]) => k)).toEqual(['a', 'b', 'nenhuma']);
    // Sabotagem que pega: inverter só as opções "de conteúdo" e deixar o "nenhuma" no fim.
    expect(plano[1].pergunta.criteria.map(([k]) => k)).toEqual(['nenhuma', 'b', 'a']);
    // a repetida é a MESMA ordem da direta: separa efeito de posição de não-determinismo
    expect(plano[2].pergunta.criteria).toEqual(plano[0].pergunta.criteria);
  });

  it('descrição nula vira null no criteria (a API aceita "sem detalhe")', () => {
    const [c] = planejarChamadas([item('i1')], new Set());
    expect(c.pergunta.criteria[0]).toEqual(['a', null]);
    expect(c.pergunta.criteria[1]).toEqual(['b', 'B']);
  });

  it('retoma: pula o que já foi respondido com sucesso (nunca paga duas vezes)', () => {
    const feitos = new Set([chaveDaChamada('i1', 'direta'), chaveDaChamada('i2', 'repetida')]);
    const plano = planejarChamadas([item('i1'), item('i2')], feitos);
    expect(plano.map((c) => chaveDaChamada(c.item.id, c.ordem))).toEqual([
      chaveDaChamada('i1', 'invertida'),
      chaveDaChamada('i1', 'repetida'),
      chaveDaChamada('i2', 'direta'),
      chaveDaChamada('i2', 'invertida'),
    ]);
  });
});
