import { describe, expect, it } from 'vitest';
import {
  montarCelulaIndividual,
  validarRespostaMelhorIndividual,
  type LinhaMelhorIndividual,
} from '../melhor-individual';

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

describe('montarCelulaIndividual — a projeção para a tela', () => {
  /** Catálogo que conhece A e B. Qualquer outro SKU é a deriva (desativado depois da geração). */
  const catalogo = (id: string) => ({ [A]: 'Verniz PU', [B]: 'Selador 500' })[id];
  const valida = (over: Partial<Record<string, unknown>> = {}) =>
    validarRespostaMelhorIndividual([linha(over)])[0];

  it('linha ausente é `nenhum` — a RPC respondeu e este cliente não tem oferta deste tipo', () => {
    expect(montarCelulaIndividual(undefined, catalogo)).toEqual({ status: 'nenhum' });
  });

  it('nome que resolve vira célula com a situação PRESERVADA', () => {
    expect(montarCelulaIndividual(valida(), catalogo)).toEqual({
      status: 'encontrado', situacao: 'eleito', nomes: ['Verniz PU'], produtos: 1, candidatos: 2,
    });
  });

  it('NENHUM nome resolvendo vira `produto_nao_resolve` — não uma célula vazia', () => {
    // Era `productName: prod?.descricao || 'Produto'`: a tela dizia ter encontrado o melhor
    // individual exibindo um literal. Perder a identidade inteira é `não sei`, não `encontrei`.
    const fora = 'cccccccc-1111-4111-8111-111111111111';
    const l = valida({ produtos: [fora], produto_eleito: fora });
    expect(montarCelulaIndividual(l, catalogo)).toEqual({
      status: 'indisponivel', motivo: 'produto_nao_resolve',
    });
  });

  it.each([['vazio', ''], ['só espaços', '   '], ['tabulação', '\t\n']])(
    'nome %s conta como não resolvido — a alternativa é uma célula em branco',
    (_rotulo, descricao) => {
      // `só espaços` é o achado R5/2, reproduzido pelo challenge executando os helpers reais:
      // `if (nome)` deixava passar `"   "`, a célula renderizava um parágrafo em BRANCO, o
      // sensor contava 1/1, e a tela não avisava nada. O schema permite essa descrição.
      expect(montarCelulaIndividual(valida(), () => descricao)).toEqual({
        status: 'indisponivel', motivo: 'produto_nao_resolve',
      });
    },
  );

  it('nome com espaços em volta é APARADO, não descartado — o produto existe', () => {
    // O outro lado do R5/2: aparar não pode virar recusa. `"  Verniz PU  "` identifica um
    // produto de verdade, e transformá-lo em `indisponivel` trocaria um defeito por outro.
    const celula = montarCelulaIndividual(valida(), () => '  Verniz PU  ');
    expect(celula.status === 'encontrado' && celula.nomes).toEqual(['Verniz PU']);
  });

  it('resolvendo ALGUNS, a situação sobrevive — o sobrevivente não vira vencedor', () => {
    // O achado R3/3, e a razão de `nomes` e `produtos` serem campos separados: colapsar para o
    // único nome legível converteria uma falha de catálogo em ELEIÇÃO. `produtos: 2` com um
    // nome só é o que deixa a tela dizer "1 de 2 sem nome" em vez de fingir decisão.
    const fora = 'cccccccc-1111-4111-8111-111111111111';
    const l = valida({ situacao: 'empatado', produtos: [A, fora], produto_eleito: null, candidatos: 2 });
    const celula = montarCelulaIndividual(l, catalogo);

    expect(celula).toEqual({
      status: 'encontrado', situacao: 'empatado', nomes: ['Verniz PU'], produtos: 2, candidatos: 2,
    });
    // O discriminador explícito: um `empatado` que perde metade dos nomes NUNCA é `eleito`.
    expect(celula.status === 'encontrado' && celula.situacao).not.toBe('eleito');
  });

  it('a ordem dos nomes é a de `produtos` — a resposta já vem ordenada e a tela não reordena', () => {
    const l = valida({ situacao: 'ordem_indisponivel', produtos: [B, A], produto_eleito: null, candidatos: 2 });
    const celula = montarCelulaIndividual(l, catalogo);
    expect(celula.status === 'encontrado' && celula.nomes).toEqual(['Selador 500', 'Verniz PU']);
  });

  it('`candidatos` maior que `produtos` sobrevive à projeção — é o grupo, não o topo', () => {
    // Em `[A:1, B:1, C:2]` saem `produtos=[A,B]` e `candidatos=3`, e a tela diz "2 de 3" — a
    // frase verdadeira. Perder o número aqui apagaria a existência do terceiro registro.
    const l = valida({ situacao: 'empatado', produtos: [A, B], produto_eleito: null, candidatos: 3 });
    const celula = montarCelulaIndividual(l, catalogo);
    expect(celula.status === 'encontrado' && celula.candidatos).toBe(3);
  });
});
