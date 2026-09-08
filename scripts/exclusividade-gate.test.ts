/**
 * Suite da maquina de exclusividade.
 *
 * O que ela precisa PROVAR, alem de "as funcoes rodam": que a ferramenta nao fabrica o proprio
 * veredito. Os tres modos de fabricar sao, em ordem de dano:
 *
 *   1. contar como EXCLUSIVO uma linha que parou cedo (a poda deixa gates DESCONHECIDOS, e
 *      desconhecido lido como "nao reprovou" inventa exclusividade que ninguem mediu);
 *   2. contar como resultado uma linha INVALIDA (regex que nao casou e ausencia de dado);
 *   3. reprovar um gate por exclusividade zero (o veredito que o parecer do Codex proibiu:
 *      corpus curto nao mede gate raro).
 */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CORPUS_DIR,
  avaliar,
  derivar,
  fingerprintDefeito,
  fonteDoGate,
  gatesCandidatos,
  jobsBloqueantes,
  parseDefeitos,
  resumir,
  type GateAlvo,
  type LinhaMatriz,
  type Matriz,
} from './lib/exclusividade';

const linha = (over: Partial<LinhaMatriz> = {}): LinhaMatriz => ({
  defeito: 'd1',
  defeitoFingerprint: 'ff',
  alvo: 'a.md',
  suspeito: null,
  origem: null,
  execucoes: [],
  parouCedo: false,
  invalido: null,
  ...over,
});

const exec = (gate: string, reprovou: boolean, ms = 10) => ({
  gate,
  reprovou,
  ms,
  fingerprint: 'fp',
  fonteResolvida: true,
});

const matriz = (over: Partial<Matriz> = {}): Matriz => ({
  schemaVersion: 1,
  medidoEm: '2026-09-07T00:00:00.000Z',
  sourceHead: 'abc',
  dispensados: [],
  baseline: [
    { gate: 'g1', verde: true, ms: 10 },
    { gate: 'g2', verde: true, ms: 20 },
  ],
  linhas: [],
  ...over,
});

describe('parseDefeitos', () => {
  it("o 3o campo e o RESTO: a expressao perl pode conter '|'", () => {
    const d = parseDefeitos('id | alvo.ts | s/(a|b)/(c|d)/', 'x.def');
    expect(d).toHaveLength(1);
    expect(d[0].perl).toBe('s/(a|b)/(c|d)/');
  });

  it('@origem e @suspeito valem para as linhas seguintes', () => {
    const d = parseDefeitos(
      ['# @origem: doc.md', '# @suspeito: docs:indice', 'a | x.ts | s/1/2/', 'b | y.ts | s/3/4/'].join('\n'),
      'x.def',
    );
    expect(d.map((x) => x.suspeito)).toEqual(['docs:indice', 'docs:indice']);
    expect(d[0].origem).toBe('doc.md');
  });

  it('ignora comentario, linha vazia e linha sem os dois separadores', () => {
    expect(parseDefeitos('# so comentario\n\nlixo sem pipe\nso | um-pipe', 'x.def')).toEqual([]);
  });

  it('o fingerprint do defeito muda quando a SABOTAGEM muda, nao quando o comentario muda', () => {
    const [a] = parseDefeitos('# @origem: um\nid | x.ts | s/1/2/', 'x.def');
    const [b] = parseDefeitos('# @origem: OUTRO\nid | x.ts | s/1/2/', 'x.def');
    const [c] = parseDefeitos('id | x.ts | s/1/3/', 'x.def');
    expect(fingerprintDefeito(a)).toBe(fingerprintDefeito(b));
    expect(fingerprintDefeito(a)).not.toBe(fingerprintDefeito(c));
  });
});

describe('jobsBloqueantes — o que de fato reprova um PR', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

  it('resolve o fecho transitivo de validate.needs', () => {
    const y = ['jobs:', '  a: {}', '  b:', '    needs: [a]', '  validate:', '    needs: [b]'].join('\n');
    expect([...jobsBloqueantes(y)].sort()).toEqual(['a', 'b']);
  });

  it('needs escrito como string (nao lista) tambem conta', () => {
    expect([...jobsBloqueantes('jobs:\n  a: {}\n  validate:\n    needs: a')]).toEqual(['a']);
  });

  // A regressao concreta: `inventarioCI` filtra `continue-on-error` no STEP e nao ve a outra
  // forma de ser informativo — um JOB inteiro fora de `validate.needs`. E o caso do
  // `mutation-check` (ci.yml:921), que o parecer do Codex marcou como informativo POR DESENHO.
  it('mutation-check NAO entra entre os bloqueantes do ci.yml de verdade', () => {
    expect(jobsBloqueantes(ci).has('mutation-check')).toBe(false);
    const mut = gatesCandidatos(ci).filter((g) => g.job === 'mutation-check');
    expect(mut.length, 'o job existe e tem gates nomeados').toBeGreaterThan(0);
    for (const g of mut) expect(g.bloqueiaPR, `${g.nome} nao pode contar como bloqueante`).toBe(false);
  });

  it('os jobs que o validate exige DE FATO contam como bloqueantes', () => {
    const b = jobsBloqueantes(ci);
    for (const j of ['typecheck', 'testes', 'edges-e-build', 'gates-e-falsificacao']) {
      expect(b.has(j), `${j} deveria bloquear`).toBe(true);
    }
  });
});

describe('fonteDoGate', () => {
  const scripts = {
    simples: 'bun scripts/gates-frescura-check.ts',
    laco: 'for t in heavy pr-collision; do bash scripts/test-$t-guard.sh || exit 1; done',
    externo: 'bunx knip',
  };

  it('resolve caminho literal', () => {
    expect(fonteDoGate('simples', scripts).arquivos).toEqual(['scripts/gates-frescura-check.ts']);
  });

  // Sem expandir o laco, os DOIS maiores gates do repo (test:hooks com 41 arquivos e
  // test:falsificacao com 12) ficariam com fonte vazia — e um gate sem fonte nunca apodrece,
  // o que e exatamente o silencio que o eixo de frescor existe para nao ter.
  it('expande o laco `for t in ...; do ... $t ...`', () => {
    expect(fonteDoGate('laco', scripts).arquivos).toEqual([
      'scripts/test-heavy-guard.sh',
      'scripts/test-pr-collision-guard.sh',
    ]);
  });

  it('ferramenta externa sem fonte no repo devolve resolvida=false, nao um hash vazio', () => {
    expect(fonteDoGate('externo', scripts).resolvida).toBe(false);
  });
});

describe('derivar — as tres formas de fabricar resultado', () => {
  it('um unico vermelho numa linha COMPLETA e exclusivo', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', false)] })] });
    expect(derivar(m).find((e) => e.gate === 'g1')!.exclusivos).toEqual(['d1']);
  });

  // Fabricacao no 1: a poda deixa gates DESCONHECIDOS. Se `parouCedo` fosse ignorado, uma linha
  // com 1 vermelho registrado (porque o 2o interrompeu antes de ser gravado) viraria exclusiva.
  it('linha que PAROU CEDO nunca produz exclusivo', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true)], parouCedo: true })] });
    expect(derivar(m).find((e) => e.gate === 'g1')!.exclusivos).toEqual([]);
    expect(derivar(m).find((e) => e.gate === 'g1')!.pegou).toEqual(['d1']);
  });

  // Fabricacao no 2: regex que nao casou e ausencia de dado, nao "ninguem pegou".
  it('linha INVALIDA nao entra em pegou nem em exclusivos', () => {
    const m = matriz({
      linhas: [linha({ execucoes: [exec('g1', true)], invalido: 'a expressao perl NAO casou nada' })],
    });
    const g1 = derivar(m).find((e) => e.gate === 'g1')!;
    expect(g1.exclusivos).toEqual([]);
    expect(g1.pegou).toEqual([]);
  });

  it('gate que nao rodou num defeito entra em naoMedido — nem pegou, nem deixou de pegar', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true)], parouCedo: true })] });
    expect(derivar(m).find((e) => e.gate === 'g2')!.naoMedido).toEqual(['d1']);
  });

  // A ferramenta cometendo, contra si mesma, a falha que existe para evitar. Na primeira medicao
  // real o vitest saiu com exclusividade zero e foi rotulado "redundante" — quando a verdade e
  // que nenhum dos 6 defeitos do corpus era de codigo de aplicacao. Zero media o CORPUS.
  it('corpusMirou distingue "redundante" de "o corpus nunca apontou para ele"', () => {
    const m = matriz({
      linhas: [
        linha({ defeito: 'd1', suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] }),
      ],
    });
    const [g1, g2] = derivar(m);
    expect(g1.corpusMirou, 'o corpus mirou g1 via @suspeito').toBe(true);
    expect(g2.corpusMirou, 'nenhum defeito declara g2 como suspeito').toBe(false);
    expect(g1.exclusivos).toEqual([]);
    expect(g2.exclusivos).toEqual([]);
  });

  it('dois vermelhos: ninguem e exclusivo, os dois pegaram', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', true)] })] });
    for (const e of derivar(m)) {
      expect(e.exclusivos).toEqual([]);
      expect(e.pegou).toEqual(['d1']);
    }
  });
});

describe('avaliar — severidade', () => {
  const g = (nome: string, bloqueiaPR = true): GateAlvo => ({ nome, linha: 1, step: 's', job: 'j', bloqueiaPR });
  const fp = new Map([['g1', { fingerprint: 'fp', resolvida: true }]]);

  it('matriz ausente reprova (fail-closed)', () => {
    const v = avaliar(null, [g('g1')], fp);
    expect(v[0].severidade).toBe('REPROVA');
    expect(v[0].codigo).toBe('MATRIZ_AUSENTE');
  });

  // O objetivo declarado da maquina: quem acrescenta um gate paga a prova de que ele pega algo
  // que ninguem pega. Sem este teste, a ferramenta inteira e decorativa.
  it('gate bloqueante sem NENHUMA medicao reprova', () => {
    const v = avaliar(matriz(), [g('novo')], new Map());
    expect(v.map((x) => x.codigo)).toContain('GATE_NOVO_SEM_EXCLUSIVIDADE');
    expect(v.find((x) => x.codigo === 'GATE_NOVO_SEM_EXCLUSIVIDADE')!.severidade).toBe('REPROVA');
  });

  it('gate na lista de dispensados nao reprova — divida DECLARADA, visivel no diff', () => {
    const m = matriz({ dispensados: [{ gate: 'novo', desde: '2026-09-07', motivo: 'pre-existente' }] });
    expect(avaliar(m, [g('novo')], new Map()).filter((v) => v.severidade === 'REPROVA')).toEqual([]);
  });

  it('gate INFORMATIVO nunca e cobrado (mutcheck e o caso real)', () => {
    expect(avaliar(matriz(), [g('mutcheck', false)], new Map())).toEqual([]);
  });

  // Fabricacao no 3, e a mais cara: e a correcao no 1 do parecer do Codex. Corpus curto nao mede
  // gate raro; `docs:links` tem dez achados no proprio historico e mesmo assim nao apareceu numa
  // janela de 80 runs. Exclusividade zero INFORMA, nunca bloqueia.
  it('exclusividade zero RELATA — jamais reprova', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] })] });
    const v = avaliar(m, [g('g1')], fp);
    const zero = v.find((x) => x.codigo === 'EXCLUSIVIDADE_ZERO')!;
    expect(zero.severidade).toBe('RELATA');
    expect(v.some((x) => x.severidade === 'REPROVA')).toBe(false);
  });

  it('o motivo do EXCLUSIVIDADE_ZERO carrega o DENOMINADOR (zero sem N le como "inutil")', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] })] });
    const zero = avaliar(m, [g('g1')], fp).find((x) => x.codigo === 'EXCLUSIVIDADE_ZERO')!;
    expect(zero.motivo).toMatch(/de 1 defeito/);
    expect(zero.motivo).toMatch(/NAO e "nao pega nada"/);
  });

  it('zero SEM mira do corpus vira CORPUS_NAO_MIROU, nao EXCLUSIVIDADE_ZERO', () => {
    const m = matriz({
      linhas: [linha({ suspeito: 'outro', execucoes: [exec('g1', true), exec('g2', true)] })],
    });
    const v = avaliar(m, [g('g1')], fp);
    expect(v.map((x) => x.codigo)).toContain('CORPUS_NAO_MIROU');
    expect(v.map((x) => x.codigo)).not.toContain('EXCLUSIVIDADE_ZERO');
    expect(v.find((x) => x.codigo === 'CORPUS_NAO_MIROU')!.motivo).toMatch(/mede o CORPUS, nao o gate/);
  });

  it('fonte mudada AVISA, nao reprova', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', true)] })] });
    const v = avaliar(m, [g('g1')], new Map([['g1', { fingerprint: 'OUTRO', resolvida: true }]]));
    const podre = v.find((x) => x.codigo === 'LINHA_PODRE')!;
    expect(podre.severidade).toBe('AVISA');
  });

  it('frescor nao verificavel e DITO em voz alta, nao silenciado', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', true)] })] });
    const v = avaliar(m, [g('g1')], new Map([['g1', { fingerprint: 'x', resolvida: false }]]));
    expect(v.some((x) => x.codigo === 'FRESCOR_INDISPONIVEL')).toBe(true);
  });
});

describe('resumir', () => {
  it('nunca imprime "nao pega nada"; sempre o denominador', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] })] });
    const txt = resumir(m);
    expect(txt).not.toMatch(/nao pega nada/i);
    expect(txt).toMatch(/NESTE corpus de 1/);
  });

  it('gate que nao pegou NADA nao e marcado como redundante (ausencia de dado != redundancia)', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g2', execucoes: [exec('g1', true)], parouCedo: true })] });
    const l = resumir(m).split('\n').find((x) => x.includes('g2'));
    expect(l, 'g2 precisa aparecer no resumo, senao o teste e vacuo').toBeDefined();
    expect(l).not.toMatch(/redund/);
  });
});

describe('o corpus de verdade', () => {
  const arquivos = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.def'));
  const defeitos = arquivos.flatMap((f) => parseDefeitos(readFileSync(`${CORPUS_DIR}/${f}`, 'utf8'), f));

  // Guarda ANTI-VACUO: um glob que para de casar faria toda assercao abaixo passar por nao achar
  // NADA — verde por ausencia de dado, a mesma familia registrada em ci-testes-edge-deno.md.
  it('o corpus real tem defeitos (o gate nao passa a vazio)', () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(1);
    expect(defeitos.length).toBeGreaterThanOrEqual(5);
  });

  it('todo defeito tem alvo que EXISTE no repo — alvo morto nao mede nada', () => {
    for (const d of defeitos) {
      expect(readFileSync(d.alvo, 'utf8').length, `${d.id}: alvo ${d.alvo}`).toBeGreaterThan(0);
    }
  });

  it('todo id e unico (id repetido sobrescreveria a linha da matriz)', () => {
    const ids = defeitos.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('todo defeito declara @suspeito e @origem — o relatorio confronta declarado x medido', () => {
    for (const d of defeitos) {
      expect(d.suspeito, `${d.id} sem @suspeito`).not.toBeNull();
      expect(d.origem, `${d.id} sem @origem`).not.toBeNull();
    }
  });
});
