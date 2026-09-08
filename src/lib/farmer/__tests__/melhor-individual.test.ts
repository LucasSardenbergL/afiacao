import { describe, expect, it } from 'vitest';
import { validarRespostaMelhorIndividual, type LinhaMelhorIndividual } from '../melhor-individual';

const CLI = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-1111-4111-8111-111111111111';
const RUN = '99999999-1111-4111-8111-111111111111';

/** Uma linha válida `eleito`, com os campos que cada teste sobrescreve. */
const linha = (over: Partial<Record<string, unknown>> = {}) => ({
  customer_user_id: CLI,
  recommendation_type: 'cross_sell',
  situacao: 'eleito',
  produtos: [A],
  produto_eleito: A,
  candidatos: 2,
  affinity_score: 0.5,
  run_id: RUN,
  ...over,
});

const valida = (over = {}) => validarRespostaMelhorIndividual([linha(over)]);

describe('validarRespostaMelhorIndividual — invariantes ENTRE campos', () => {
  it('aceita a linha bem formada', () => {
    const [l] = valida() as LinhaMelhorIndividual[];
    expect(l.situacao).toBe('eleito');
    expect(l.produto_eleito).toBe(A);
  });

  it('aceita o caso [A:1, B:1, C:2]: 2 nomeados de 3 candidatos', () => {
    expect(() =>
      valida({ situacao: 'empatado', produtos: [A, B], produto_eleito: null, candidatos: 3 }),
    ).not.toThrow();
  });

  // ── o que a validação campo a campo deixava passar ────────────────────────────
  it('rejeita empatado com UM produto — cada campo passa, o conjunto não representa empate', () => {
    expect(() =>
      valida({ situacao: 'empatado', produtos: [A], produto_eleito: null, candidatos: 2 }),
    ).toThrow(/empatado exige/);
  });

  it('rejeita ordem_indisponivel que esconde um registrado', () => {
    // Promete transportar TODOS os registrados; com 2 de 3 a tela diria "3 registradas"
    // mostrando 2 — esconder uma oferta sem dizer que escondeu.
    expect(() =>
      valida({ situacao: 'ordem_indisponivel', produtos: [A, B], produto_eleito: null, candidatos: 3 }),
    ).toThrow(/produtos \(2\) = candidatos \(3\)/);
  });

  it('rejeita referencia_ambigua com um produto e dois candidatos', () => {
    expect(() =>
      valida({ situacao: 'referencia_ambigua', produtos: [A], produto_eleito: null, candidatos: 2 }),
    ).toThrow(/produtos \(1\) = candidatos \(2\)/);
  });

  it('rejeita produto_eleito fora do estado eleito', () => {
    expect(() =>
      valida({ situacao: 'empatado', produtos: [A, B], produto_eleito: A, candidatos: 2 }),
    ).toThrow(/exatamente o estado eleito/);
  });

  it('rejeita eleito sem produto_eleito', () => {
    expect(() => valida({ produto_eleito: null })).toThrow(/exatamente o estado eleito/);
  });

  it('rejeita produto_eleito que não está em produtos', () => {
    expect(() => valida({ produtos: [A], produto_eleito: B })).toThrow(/fora de produtos/);
  });

  it('rejeita eleito com um único candidato — não venceu de ninguém', () => {
    expect(() => valida({ candidatos: 1 })).toThrow(/eleito exige/);
  });

  // ── formato: `typeof === 'string'` não basta ──────────────────────────────────
  it('rejeita customer_user_id que não é uuid', () => {
    // Uma string qualquer some na consulta pela chave do Map, e sumir é indistinguível de
    // "este cliente não tem oferta" — que é um veredicto.
    expect(() => valida({ customer_user_id: 'nao-e-uuid' })).toThrow(/customer_user_id não é uuid/);
  });

  it('rejeita SKU que não é uuid', () => {
    expect(() => valida({ produtos: ['produto-sem-uuid'], produto_eleito: 'produto-sem-uuid' }))
      .toThrow(/produtos contém item que não é uuid/);
  });

  it('rejeita produtos com duplicata', () => {
    expect(() =>
      valida({ situacao: 'empatado', produtos: [A, A], produto_eleito: null, candidatos: 2 }),
    ).toThrow(/duplicata/);
  });

  it('rejeita produtos maior que candidatos', () => {
    expect(() =>
      valida({ situacao: 'empatado', produtos: [A, B], produto_eleito: null, candidatos: 1 }),
    ).toThrow(/excede candidatos/);
  });

  it('rejeita candidatos zero, fracionário e não-numérico', () => {
    expect(() => valida({ candidatos: 0 })).toThrow(/inteiro >= 1/);
    expect(() => valida({ candidatos: 1.5 })).toThrow(/inteiro >= 1/);
    expect(() => valida({ candidatos: '2' })).toThrow(/inteiro >= 1/);
  });

  it('rejeita situacao fora do enum e tipo desconhecido', () => {
    expect(() => valida({ situacao: 'ordem_desconhecida' })).toThrow(/situacao inválida/);
    expect(() => valida({ recommendation_type: 'bundle' })).toThrow(/tipo desconhecido/);
  });

  it('rejeita (cliente,tipo) duplicado', () => {
    expect(() => validarRespostaMelhorIndividual([linha(), linha()])).toThrow(/duplicado/);
  });

  it('aceita os DOIS tipos do mesmo cliente — é o desenho', () => {
    expect(() =>
      validarRespostaMelhorIndividual([linha(), linha({ recommendation_type: 'up_sell' })]),
    ).not.toThrow();
  });

  it('aceita run_id nulo (geração incoerente não transporta) e recusa run_id malformado', () => {
    expect(() => valida({ run_id: null })).not.toThrow();
    expect(() => valida({ run_id: 'x' })).toThrow(/run_id presente mas não é uuid/);
  });

  // ── a resposta inteira ────────────────────────────────────────────────────────
  it('rejeita não-array, distinguindo null de outros tipos', () => {
    expect(() => validarRespostaMelhorIndividual(null)).toThrow(/devolveu null/);
    expect(() => validarRespostaMelhorIndividual({})).toThrow(/devolveu object/);
  });

  it('aceita [] — "li e não há" é resposta legítima', () => {
    expect(validarRespostaMelhorIndividual([])).toEqual([]);
  });

  it('LANÇA em vez de filtrar: uma linha ruim derruba a resposta INTEIRA', () => {
    // Filtrar entregaria um Map parcial apresentado como completo, e os clientes ausentes
    // virariam `nenhum` — falha convertida em ausência.
    expect(() => validarRespostaMelhorIndividual([linha(), linha({ customer_user_id: 'x' })]))
      .toThrow(/linha 1/);
  });
});
