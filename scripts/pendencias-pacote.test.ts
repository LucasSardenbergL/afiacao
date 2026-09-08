import { describe, expect, it } from 'vitest';

import { lerVeredito, separarSaida } from './pendencias-pacote';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Por que este arquivo existe
// ═══════════════════════════════════════════════════════════════════════════════════════════
// O `pendencias:pacote` é o GATE de ordem entre camadas (#2369): ele recusa a colagem da edge
// enquanto o banco de prod não tem a RPC que ela chama. Um gate que não lê a leva não gateia
// nada — e era o caso. `args.indexOf('--saida')` devolve `-1` quando a flag está ausente, então
// `iSaida + 1` valia **0** e o `filter` comia o argumento de índice 0: o `-` do pipe canônico
// impresso no próprio `uso:`, ou a única edge nomeada.
//
// O modo de falha não era um erro: era um VERDE. O CLI escrevia "✓ nada pendente de deploy" e
// saía 1 — a mesma saída de uma leva legitimamente vazia. Medido em 2026-09-08 com a
// `copilot-analyze` em `DIVERGE_P1`: `pendencias:pacote copilot-analyze` dizia "nada pendente",
// e `pendencias:pacote copilot-analyze --saida x.md` emitia o pacote. Um dia de gate cego.
//
// Estes testes cobrem a função PURA que passou a fazer a separação, e o par que falsifica:
// a asserção sem `--saida` fica VERMELHA se alguém restaurar o filtro de índice.

describe('separarSaida — o argumento de índice 0 sobrevive', () => {
  it('sem --saida, TODOS os alvos sobrevivem (o `-` do pipe canônico inclusive)', () => {
    expect(separarSaida(['-'])).toEqual({ nomes: ['-'] });
    expect(separarSaida(['copilot-analyze'])).toEqual({ nomes: ['copilot-analyze'] });
    expect(separarSaida(['a', 'b', 'c'])).toEqual({ nomes: ['a', 'b', 'c'] });
  });

  it('com --saida no fim, o alvo de índice 0 sobrevive e o caminho é extraído', () => {
    expect(separarSaida(['copilot-analyze', '--saida', 'p.md'])).toEqual({
      nomes: ['copilot-analyze'],
      saida: 'p.md',
    });
  });

  it('com --saida no começo, o alvo depois dela sobrevive', () => {
    expect(separarSaida(['--saida', 'p.md', 'copilot-analyze'])).toEqual({
      nomes: ['copilot-analyze'],
      saida: 'p.md',
    });
  });

  it('--saida sem caminho devolve `saida` indefinido — quem decide o exit 2 é o `main`', () => {
    expect(separarSaida(['edge-a', '--saida'])).toEqual({ nomes: ['edge-a'], saida: undefined });
  });

  it('sem argumento nenhum, leva vazia — e nada de `saida`', () => {
    expect(separarSaida([])).toEqual({ nomes: [] });
  });
});

describe('lerVeredito — o contrato com o pendencias:deploy --json', () => {
  const veredito = (estado: string, edge = 'copilot-analyze') => ({
    formato: 'pendencias-deploy/1',
    vereditos: [{ edge, estado }],
  });

  it('DIVERGE_P1 entra na leva — é o estado que a `copilot-analyze` tinha', () => {
    expect(lerVeredito(JSON.stringify(veredito('DIVERGE_P1')))).toEqual(['copilot-analyze']);
  });

  it('CONFERE não entra', () => {
    expect(lerVeredito(JSON.stringify(veredito('CONFERE')))).toEqual([]);
  });

  it('NUNCA_ATESTADA não entra — ausência de dado pede SONDA, não deploy', () => {
    expect(lerVeredito(JSON.stringify(veredito('NUNCA_ATESTADA')))).toEqual([]);
  });

  it('formato desconhecido LANÇA — não adivinha a leva', () => {
    expect(() => lerVeredito('{"formato":"outro/9","vereditos":[]}')).toThrow(/formato inesperado/);
  });

  it('JSON sem `vereditos` LANÇA — ausente ≠ leva vazia', () => {
    expect(() => lerVeredito('{"formato":"pendencias-deploy/1"}')).toThrow(/sem `vereditos`/);
  });

  it('stdin que não é JSON LANÇA', () => {
    expect(() => lerVeredito('nada disso')).toThrow(/não é JSON/);
  });
});
