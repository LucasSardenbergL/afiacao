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
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';

import {
  CORPUS_DIR,
  RECEITAS,
  SCHEMA_VERSION,
  aplicarBumpVersao,
  avaliar,
  bloqueantesOpacos,
  conferirAncoraDaRaiz,
  derivar,
  exclusividadeVermelhaSoPorGateNovo,
  fingerprintDefeito,
  fonteDoGate,
  fundirLinhas,
  gatesCandidatos,
  invocacaoDoCI,
  jobsBloqueantes,
  lerMatriz,
  parseDefeitos,
  primeiraLinhaComCarne,
  resumir,
  textoDoDever,
  type Defeito,
  type GateAlvo,
  type LeituraDaMatriz,
  type LinhaMatriz,
  type Matriz,
} from './lib/exclusividade';
import { nomesDeScript } from './gates-frescura-check';
import { extrairVersao } from './sonda-versao-bump-gate';

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
  schemaVersion: SCHEMA_VERSION,
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

/** A leitura aceita de `m`, sem passar pelo texto — para os testes que nao sao sobre a LEITURA. */
const lida = (m: Matriz): LeituraDaMatriz => ({ ok: true, matriz: m });

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

// ---------------------------------------------------------------------------------------------
// @dever-de-casa — o formato passa a expressar o autor DILIGENTE (defeito + o conserto que o
// proprio gate concorrente prescreve), por VOCABULARIO FECHADO, nunca por comando livre
// ---------------------------------------------------------------------------------------------

describe('parseDefeitos — @dever-de-casa', () => {
  const EDGE = 'supabase/functions/fin-funding/index.ts';

  // A assimetria com @suspeito e o ponto: herdado por engano, um dever de casa neutralizaria os
  // gates de bytes num defeito que nao o pediu — exclusividade INFLADA, o erro caro.
  it('vale SO para a PROXIMA linha de defeito — nao e pegajoso como @suspeito', () => {
    const d = parseDefeitos(
      ['# @suspeito: g', '# @dever-de-casa: regenerar-fingerprints', `a | ${EDGE} | s/1/2/`, `b | ${EDGE} | s/3/4/`].join('\n'),
      'x.def',
    );
    expect(d.map((x) => x.deveres.map(textoDoDever))).toEqual([['regenerar-fingerprints'], []]);
    expect(d.map((x) => x.suspeito)).toEqual(['g', 'g']);
  });

  it('varios @dever-de-casa acumulam EM ORDEM para a mesma linha', () => {
    const [d] = parseDefeitos(
      ['# @dever-de-casa: bump-versao fin-funding', '# @origem: o', '# @dever-de-casa: regenerar-fingerprints', `a | ${EDGE} | s/1/2/`].join('\n'),
      'x.def',
    );
    expect(d.deveres.map(textoDoDever)).toEqual(['bump-versao fin-funding', 'regenerar-fingerprints']);
  });

  it('@dever-de-casa pendurado no fim do arquivo e ERRO — dever que nao se aplica a nada', () => {
    expect(() => parseDefeitos(`a | ${EDGE} | s/1/2/\n# @dever-de-casa: regenerar-fingerprints`, 'x.def')).toThrow(
      /DEVER-DE-CASA-PENDURADO/,
    );
  });

  // Comando livre era a porta para FABRICAR exclusividade: um "pos-passo" que silencia o script de
  // um concorrente, deixa o alvo intacto e sai 0 passa por qualquer guarda de efeito. Fora do
  // vocabulario, nem parseia.
  it('receita fora do vocabulario e ERRO — nao existe "rode este comando"', () => {
    expect(() => parseDefeitos(`# @dever-de-casa: sh -c 'rm scripts/gate.ts'\na | ${EDGE} | s/1/2/`, 'x.def')).toThrow(
      /DEVER-DE-CASA-INVALIDO/,
    );
  });

  it('aridade errada e ERRO', () => {
    expect(() => parseDefeitos(`# @dever-de-casa: bump-versao\na | ${EDGE} | s/1/2/`, 'x.def')).toThrow(/DEVER-DE-CASA-INVALIDO/);
    expect(() => parseDefeitos(`# @dever-de-casa: regenerar-fingerprints x\na | ${EDGE} | s/1/2/`, 'x.def')).toThrow(
      /DEVER-DE-CASA-INVALIDO/,
    );
  });

  // A receita so e dever de casa DO DEFEITO se o defeito esta no dominio do gate que a prescreve.
  // Bumpar o VERSAO de outra edge, ou regenerar o mapa para um defeito fora das edges, seria usar a
  // receita como alavanca para calar gate que nao tinha nada a ver com o defeito.
  it('receita fora do dominio do alvo e ERRO', () => {
    expect(() => parseDefeitos(`# @dever-de-casa: bump-versao outra-edge\na | ${EDGE} | s/1/2/`, 'x.def')).toThrow(
      /DEVER-DE-CASA-INVALIDO/,
    );
    expect(() => parseDefeitos('# @dever-de-casa: regenerar-fingerprints\na | docs/x.md | s/1/2/', 'x.def')).toThrow(
      /DEVER-DE-CASA-INVALIDO/,
    );
    expect(() => parseDefeitos('# @dever-de-casa: bump-versao ../../etc\na | x.ts | s/1/2/', 'x.def')).toThrow(
      /DEVER-DE-CASA-INVALIDO/,
    );
  });

  // Trava a formula antiga por VALOR: se o dever de casa entrasse no hash de todo defeito, as linhas
  // ja medidas da matriz mudariam de fingerprint sem que nada nelas tivesse mudado.
  it('defeito SEM dever de casa mantem o fingerprint de antes (as linhas medidas nao apodrecem)', () => {
    const [d] = parseDefeitos('id | x.ts | s/1/2/', 'x.def');
    expect(fingerprintDefeito(d)).toBe('f3581e1ab9529d2c');
  });

  it('o fingerprint muda com o dever de casa — outro fluxo e outra medicao', () => {
    const [a] = parseDefeitos(`# @dever-de-casa: regenerar-fingerprints\nid | ${EDGE} | s/1/2/`, 'x.def');
    const [b] = parseDefeitos(`# @dever-de-casa: bump-versao fin-funding\nid | ${EDGE} | s/1/2/`, 'x.def');
    const [c] = parseDefeitos(`id | ${EDGE} | s/1/2/`, 'x.def');
    expect(new Set([fingerprintDefeito(a), fingerprintDefeito(b), fingerprintDefeito(c)]).size).toBe(3);
  });
});

describe('RECEITAS — o criterio de admissao no vocabulario', () => {
  // Uma receita so entra se for o conserto que o PROPRIO gate concorrente prescreve na mensagem de
  // falha dele. E o que separa "o autor fez o dever de casa" de "o autor calou o gate": a
  // neutralizacao e exatamente a que o gate desenhou para aceitar. Se o gate parar de prescrever,
  // a receita perde o direito de existir — e este teste fica vermelho.
  it('cada receita e prescrita, LITERALMENTE, pela fonte do gate que ela satisfaz', () => {
    const nomes = Object.keys(RECEITAS);
    expect(nomes.length, 'anti-vacuo').toBeGreaterThanOrEqual(2);
    for (const nome of nomes) {
      const { gate, fonte, remedio } = RECEITAS[nome as keyof typeof RECEITAS].prescritaPor;
      expect(readFileSync(fonte, 'utf8'), `${nome}: ${fonte} nao prescreve mais "${remedio}" (${gate})`).toContain(remedio);
    }
  });
});

describe('aplicarBumpVersao', () => {
  const versao = ['// comenta o `export const VERSAO = "antigo"` de outrora', 'export const VERSAO = "v1.0-x";', 'export const EFEITO = 1;'].join('\n');

  it('muda SO o literal do export — o sonda:bump le o VERSAO novo', () => {
    const r = aplicarBumpVersao(versao);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.de).toBe('v1.0-x');
    expect(r.para).not.toBe('v1.0-x');
    expect(extrairVersao(r.novo)).toBe(r.para);
    const antes = versao.split('\n');
    const depois = r.novo.split('\n');
    expect(depois.filter((l, i) => l !== antes[i]), 'exatamente 1 linha mudou').toHaveLength(1);
    expect(depois[0], 'o comentario que cita VERSAO fica intocado').toBe(antes[0]);
  });

  it('sem export legivel, ou com dois, e recusado — nunca um bump chutado', () => {
    expect(aplicarBumpVersao('export const EFEITO = 1;').ok).toBe(false);
    expect(aplicarBumpVersao('export const VERSAO = "a";\nexport const VERSAO = "b";').ok).toBe(false);
  });
});

describe('fundirLinhas — so funde a MESMA sabotagem, medida validamente dos dois lados', () => {
  it('fingerprint do defeito diferente: a linha nova SUBSTITUI (execucoes de outra sabotagem nao valem)', () => {
    const antiga = linha({ defeitoFingerprint: 'AAA', execucoes: [exec('g1', false), exec('g2', true)] });
    const nova = linha({ defeitoFingerprint: 'BBB', execucoes: [exec('g1', true)] });
    expect(fundirLinhas(antiga, nova).execucoes.map((e) => e.gate)).toEqual(['g1']);
  });

  it('linha antiga INVALIDA nao ressuscita execucao', () => {
    const antiga = linha({ execucoes: [exec('g2', false)], invalido: 'gate g3 estourou o tempo' });
    const nova = linha({ execucoes: [exec('g1', true)] });
    expect(fundirLinhas(antiga, nova)).toEqual(nova);
  });

  it('linha nova INVALIDA descarta a antiga — o defeito nao se aplica mais como foi medido', () => {
    const antiga = linha({ execucoes: [exec('g1', true)] });
    const nova = linha({ execucoes: [], invalido: 'a expressao perl NAO casou nada' });
    expect(fundirLinhas(antiga, nova)).toEqual(nova);
  });
});

describe('derivar — CERTIFICAR exclusivo exige o universo inteiro executado', () => {
  const universo = ['g1', 'g2', 'g3'];

  // A fabricacao que estava viva na matriz real: `bun-despinado` rodou 7 de 31 gates, teve 1
  // vermelho e `parouCedo=false` — e saia `[SO ELE]`. Os outros 24 NAO reprovaram porque nao rodaram.
  it('linha que nao rodou todo o universo, com 1 vermelho, e INCONCLUSIVA — nao exclusiva', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', false)] })] });
    const g1 = derivar(m, { universo }).find((e) => e.gate === 'g1')!;
    expect(g1.exclusivos).toEqual([]);
    expect(g1.inconclusivos).toEqual(['d1']);
    expect(g1.pegou).toEqual(['d1']);
  });

  it('com o universo inteiro executado, 1 vermelho CERTIFICA', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', false), exec('g3', false)] })] });
    expect(derivar(m, { universo }).find((e) => e.gate === 'g1')!.exclusivos).toEqual(['d1']);
  });

  // `tsc` na matriz real: o motor rodava `bun run tsc` (no-op) e o CI roda `bunx tsc -p ...`. A
  // execucao de invocacao diferente nao e evidencia sobre o gate — nem verde, nem vermelho.
  it('execucao com invocacao diferente da do CI NAO conta (nem para completude, nem para pegou)', () => {
    const assinaturas = new Map([
      ['g1', 'bun run g1'],
      ['g2', 'bun run g2'],
      ['g3', 'bunx g3 -p cfg'],
    ]);
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', false), exec('g3', false)] })] });
    const d = derivar(m, { universo, assinaturas });
    expect(d.find((e) => e.gate === 'g1')!.exclusivos, 'g3 nao rodou o que o CI roda').toEqual([]);
    expect(d.find((e) => e.gate === 'g3')!.rodou).toEqual([]);
    expect(d.find((e) => e.gate === 'g3')!.naoMedido).toEqual(['d1']);
  });

  it('execucao que gravou a invocacao do CI conta', () => {
    const assinaturas = new Map([['g1', 'bun run g1'], ['g2', 'bun run g2'], ['g3', 'bunx g3 -p cfg']]);
    const e3 = { ...exec('g3', false), invocacao: 'bunx g3 -p cfg' };
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', false), e3] })] });
    expect(derivar(m, { universo, assinaturas }).find((e) => e.gate === 'g1')!.exclusivos).toEqual(['d1']);
  });

  it('rodou lista so as linhas VALIDAS em que o gate foi executado', () => {
    const m = matriz({
      linhas: [
        linha({ defeito: 'd1', execucoes: [exec('g1', false)] }),
        linha({ defeito: 'd2', execucoes: [exec('g1', true)], invalido: 'x' }),
        linha({ defeito: 'd3', execucoes: [exec('g2', true)], parouCedo: true }),
      ],
    });
    const g1 = derivar(m).find((e) => e.gate === 'g1')!;
    expect(g1.rodou).toEqual(['d1']);
    expect(g1.naoMedido).toEqual(['d2', 'd3']);
  });

  it('corpusMirou exige a linha que mira VALIDA — mira em linha invalida nao mediu nada', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [], invalido: 'perl falhou' })] });
    expect(derivar(m).find((e) => e.gate === 'g1')!.corpusMirou).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Paridade de invocacao — o motor roda O QUE O CI RODA, nao `bun run <nome>` cru
// ---------------------------------------------------------------------------------------------

describe('invocacaoDoCI', () => {
  const yml = (steps: string) => `jobs:\n  j:\n    steps:\n${steps}\n  validate:\n    needs: [j]`;
  const passo = (run: string, extra = '') => `      - name: s\n        run: ${run}${extra}`;

  it('`bun run <nome>` cru devolve o argv cru, sem env', () => {
    expect(invocacaoDoCI(yml(passo('bun run g1')), 'g1')).toEqual({ ok: true, argv: ['bun', 'run', 'g1'], env: {} });
  });

  // O defeito (1) inteiro: sem o `--gate`, `sonda-cron-prova.ts` e o modo BACKFILL, que regrava
  // o manifesto e suja a arvore para todo gate seguinte.
  it('carrega os argumentos do CI (`-- --gate`)', () => {
    expect(invocacaoDoCI(yml(passo('bun run g1 -- --gate')), 'g1')).toEqual({
      ok: true,
      argv: ['bun', 'run', 'g1', '--', '--gate'],
      env: {},
    });
  });

  // `bun run tsc` cru (sem script `tsc`) roda o binario contra o tsconfig raiz, `files: []`: no-op.
  it('forma `bunx <bin> <args>` — o tsc do CI', () => {
    const r = invocacaoDoCI(yml(passo('bunx tsc --noEmit -p tsconfig.app.json')), 'tsc');
    expect(r).toEqual({ ok: true, argv: ['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.app.json'], env: {} });
  });

  it('forma `bun <script>` — o lint do CI', () => {
    expect(invocacaoDoCI(yml(passo('bun lint')), 'lint')).toEqual({ ok: true, argv: ['bun', 'lint'], env: {} });
  });

  // Recortar o comando simples de dentro de um step composto perderia o que o compoe: `cd sub;
  // bun run g1` perde o diretorio, `bun run g1 || true` perde o fato de o step NUNCA reprovar. O
  // status do step pertence ao step inteiro — logo so um `run:` que E um comando simples e medivel.
  it('step COMPOSTO (separador, redirecionamento, comentario, multilinha) e NAO REPRODUZIVEL', () => {
    for (const run of ["'cd sub; bun run g1'", "'bun run g1 || true'", "'bun run g1 | tee o'", "'bun run g1 # nota'", '|\n          set -e\n          bun run g1']) {
      const r = invocacaoDoCI(yml(passo(run)), 'g1');
      expect(r.ok, run).toBe(false);
      expect(!r.ok && r.motivo, run).toMatch(/NAO-REPRODUZIVEL/);
    }
  });

  it('working-directory muda o que roda — NAO REPRODUZIVEL', () => {
    const r = invocacaoDoCI(yml(passo('bun run g1', '\n        working-directory: sub')), 'g1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toMatch(/NAO-REPRODUZIVEL/);
  });

  it('env LITERAL do step entra na invocacao', () => {
    const r = invocacaoDoCI(yml(passo('bun run g1', '\n        env:\n          NODE_ENV: production')), 'g1');
    expect(r).toEqual({ ok: true, argv: ['bun', 'run', 'g1'], env: { NODE_ENV: 'production' } });
  });

  // Fail-closed: o motor nao tem o contexto do GitHub. Adivinhar o valor seria medir OUTRO comando
  // e chamar o resultado de medicao do gate — o mesmo defeito (1), por outro caminho.
  it('env com expressao `${{ }}` e NAO REPRODUZIVEL', () => {
    const r = invocacaoDoCI(yml(passo('bun run g1', '\n        env:\n          T: ${{ secrets.X }}')), 'g1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toMatch(/NAO-REPRODUZIVEL/);
  });

  it('token com aspas, $VAR ou glob e NAO REPRODUZIVEL (nunca um palpite)', () => {
    for (const run of ['bun run g1 -- "a b"', 'bun run g1 -- $X', 'bun run g1 -- src/*.ts']) {
      const r = invocacaoDoCI(yml(passo(`'${run}'`)), 'g1');
      expect(r.ok, run).toBe(false);
      expect(!r.ok && r.motivo, run).toMatch(/NAO-REPRODUZIVEL/);
    }
  });

  it('o mesmo gate com invocacoes DIFERENTES em dois steps e AMBIGUO', () => {
    const r = invocacaoDoCI(yml(`${passo('bun run g1')}\n${passo('bun run g1 -- --x')}`), 'g1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toMatch(/AMBIGUA/);
  });

  it('step informativo (continue-on-error) nao conta como invocacao do gate', () => {
    const y = yml(`${passo('bun run g1')}\n      - name: aviso\n        continue-on-error: true\n        run: bun run g1 -- --x`);
    expect(invocacaoDoCI(y, 'g1')).toEqual({ ok: true, argv: ['bun', 'run', 'g1'], env: {} });
  });

  it('gate que o ci.yml nao invoca devolve erro, nao o argv cru inventado', () => {
    const r = invocacaoDoCI(yml(passo('bun run g1')), 'outro');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toMatch(/SEM-INVOCACAO/);
  });

  describe('o ci.yml de VERDADE', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const bloqueantes = gatesCandidatos(ci).filter((g) => g.bloqueiaPR);

    it('todo gate bloqueante tem invocacao reproduzivel', () => {
      expect(bloqueantes.length, 'anti-vacuo: o censo tem de ter achado gates').toBeGreaterThan(20);
      for (const g of bloqueantes) {
        const r = invocacaoDoCI(ci, g.nome);
        expect(r.ok, `${g.nome}: ${!r.ok ? r.motivo : ''}`).toBe(true);
      }
    });

    // Os tres casos que o motor media ERRADO antes desta entrega, cada um pelo seu motivo.
    it('sonda:cron-prova leva --gate, tsc leva -p tsconfig.app.json, build leva NODE_ENV', () => {
      const cron = invocacaoDoCI(ci, 'sonda:cron-prova');
      const tsc = invocacaoDoCI(ci, 'tsc');
      const build = invocacaoDoCI(ci, 'build');
      expect(cron.ok && cron.argv).toContain('--gate');
      expect(tsc.ok && tsc.argv.join(' ')).toMatch(/^bunx tsc .*-p tsconfig\.app\.json/);
      expect(build.ok && build.env).toEqual({ NODE_ENV: 'production' });
    });
  });
});

describe('jobsBloqueantes — o que de fato reprova um PR', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

  it('resolve o fecho transitivo de validate.needs — com a RAIZ dentro', () => {
    const y = ['jobs:', '  a: {}', '  b:', '    needs: [a]', '  validate:', '    needs: [b]'].join('\n');
    expect([...jobsBloqueantes(y)].sort()).toEqual(['a', 'b', 'validate']);
  });

  it('needs escrito como string (nao lista) tambem conta', () => {
    expect([...jobsBloqueantes('jobs:\n  a: {}\n  validate:\n    needs: a')].sort()).toEqual([
      'a',
      'validate',
    ]);
  });

  // A fresta que o #2376 deixou aberta: `needs` aponta para tras, ninguem aponta para o
  // `validate`, e um fecho que parte de `validate.needs` exclui a RAIZ por construcao — logo um
  // step dentro dela sumia das DUAS contas ao mesmo tempo (nem `bloqueiaPR`, nem opaco).
  it('o proprio validate BLOQUEIA o PR — e o required check do auto-merge', () => {
    expect(jobsBloqueantes(ci).has('validate')).toBe(true);
  });

  // O outro lado da mesma linha: incluir a raiz nao pode virar presenca FABRICADA. Um ci.yml sem
  // `validate` tem de continuar devolvendo vazio — que e como se diz "nao achei o required check".
  it('sem job validate no arquivo, o conjunto e VAZIO (nao um nome inventado)', () => {
    expect([...jobsBloqueantes('jobs:\n  a: {}\n  b:\n    needs: [a]')]).toEqual([]);
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

// ---------------------------------------------------------------------------------------------
// O contador de opacos — o que o numero "N gate(s) bloqueante(s)" estava escondendo
// ---------------------------------------------------------------------------------------------

describe('conferirAncoraDaRaiz — o vacuo que desligaria a maquina inteira', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const autoMerge = readFileSync('.github/workflows/auto-merge.yml', 'utf8');

  // CONTROLE. Vem primeiro de proposito: um `describe` que ja estivesse acusando por outro motivo
  // aprovaria todas as sabotagens abaixo sem provar nada (docs/historico/falsificacao-sem-linha-de-base.md).
  it('as fontes REAIS de hoje nao acusam nada', () => {
    expect(conferirAncoraDaRaiz(ci, autoMerge)).toEqual([]);
  });

  // O literal, nunca o simbolo: `JOB_RAIZ` nao e exportado justamente para a assercao nao se mover
  // junto com o codigo. Este `sed` e o defeito que o guard existe para pegar.
  const ciSemRaiz = ci.replace(/^ {2}validate:$/m, '  valida-tudo:');

  it('renomear o job `validate` no ci.yml REPROVA — nao devolve censo vazio calado', () => {
    expect(ciSemRaiz).not.toBe(ci); // a sabotagem precisa ter MORDIDO
    const codigos = conferirAncoraDaRaiz(ciSemRaiz, autoMerge).map((p) => p.codigo);
    expect(codigos).toContain('RAIZ_AUSENTE_NO_CI');
    expect(codigos).toContain('FECHO_BLOQUEANTE_VAZIO');
  });

  // A cascata inteira que o guard intercepta, medida no MESMO fixture: sem ele, isto e o que o
  // gate veria — e "0 bloqueante(s)" le como cobertura total.
  it('e o vacuo e REAL: sem o guard, todo gate viraria nao-bloqueante', () => {
    expect(jobsBloqueantes(ciSemRaiz).size).toBe(0);
    const cands = gatesCandidatos(ciSemRaiz);
    expect(cands.length).toBeGreaterThan(20); // os gates continuam TODOS la...
    expect(cands.filter((g) => g.bloqueiaPR)).toEqual([]); // ...e nenhum seria cobrado
    expect(bloqueantesOpacos(ciSemRaiz)).toEqual([]);
  });

  it('auto-merge que nao cita mais o check REPROVA (as duas pontas discordam)', () => {
    const semCitacao = autoMerge.replace(/`validate`/g, '`o check obrigatorio`');
    expect(semCitacao).not.toBe(autoMerge);
    expect(conferirAncoraDaRaiz(ci, semCitacao).map((p) => p.codigo)).toEqual(['ANCORA_AUTO_MERGE_PERDIDA']);
  });

  it('auto-merge AUSENTE REPROVA — some a segunda ponta, some o cruzamento', () => {
    expect(conferirAncoraDaRaiz(ci, null).map((p) => p.codigo)).toEqual(['ANCORA_AUTO_MERGE_PERDIDA']);
  });

  // Casar a palavra solta acharia `validate` dentro de um `validate-schema` futuro e o guard ficaria
  // verde por homonimo — a mesma familia do `grep` sem fronteira de palavra.
  it('nao aceita homonimo: `validate` dentro de outro nome nao serve de ancora', () => {
    const impostor = autoMerge.replace(/`validate`/g, '`validate-schema`');
    expect(conferirAncoraDaRaiz(ci, impostor).map((p) => p.codigo)).toEqual(['ANCORA_AUTO_MERGE_PERDIDA']);
  });

  // ---- Eixo POR FORA: o BINARIO, com exit code de verdade -------------------------------------
  // O vitest acima prova a funcao PURA. Guard puro e guard que pode nunca ter sido LIGADO ao exit
  // code — a via morta. Estes dois rodam o processo real.
  //
  // O discriminante e o MARCADOR, nao o exit code sozinho: uma REPROVA legitima da matriz tambem
  // sai 1, e casar so o numero faria a sabotagem "passar" pelo motivo errado no dia em que a
  // matriz reprovasse. Marcador ASCII, caixa fixa, casado sem `-i`.
  const MARCA = 'ANCORA-DA-RAIZ-QUEBRADA';
  const rodarGate = (args: string[]) => {
    const r = spawnSync('bun', ['scripts/exclusividade-gate.ts', ...args], { encoding: 'utf8' });
    return { status: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  it('o BINARIO reprova (exit 1 + marcador) contra um ci.yml sem a raiz', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'excl-ancora-'));
    const arq = join(tmp, 'ci-sabotado.yml');
    writeFileSync(arq, ciSemRaiz);
    try {
      const controle = rodarGate([]);
      expect(controle.saida, 'controle ja vermelho — nenhuma sabotagem abaixo provaria nada').not.toContain(MARCA);

      const sabotado = rodarGate(['--ci', arq]);
      expect(sabotado.saida).toContain(MARCA);
      expect(sabotado.status).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('bloqueantesOpacos — exclusao silenciosa le como cobertura total', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const yml = (jobs: string) => `jobs:\n${jobs}\n  validate:\n    needs: [j]`;

  it('step bloqueante SEM nome de script aparece', () => {
    const y = yml("  j:\n    steps:\n      - name: nucleo\n        run: bash db/roda-nucleo-ci.sh");
    expect(bloqueantesOpacos(y)).toEqual([{ job: 'j', step: 'nucleo', comando: 'bash db/roda-nucleo-ci.sh' }]);
  });

  it('step COM nome de script nao aparece — ele ja e cobrado pelo censo', () => {
    const y = yml("  j:\n    steps:\n      - name: t\n        run: bun run test");
    expect(bloqueantesOpacos(y)).toEqual([]);
  });

  it('continue-on-error nao aparece — informativo por desenho nao e lacuna', () => {
    const y = yml("  j:\n    steps:\n      - name: aviso\n        continue-on-error: true\n        run: bash x.sh");
    expect(bloqueantesOpacos(y)).toEqual([]);
  });

  // O eixo aqui e "reprova o PR", nao "reprova alguma coisa" — e o que separa este contador do
  // `bloqueantesSemScript` do gates:frescura, que nao tem o grafo de `needs` e por isso lista
  // tambem o `authz-sentinela`. Os dois estao certos, em eixos diferentes.
  it('step de job FORA de validate.needs nao aparece', () => {
    const y = `jobs:\n  solto:\n    steps:\n      - name: x\n        run: bash x.sh\n  j: {}\n  validate:\n    needs: [j]`;
    expect(bloqueantesOpacos(y)).toEqual([]);
    expect(bloqueantesOpacos(ci).some((o) => o.job === 'authz-sentinela')).toBe(false);
  });

  // A REGRESSAO que originou tudo: o #2364 pos `bash db/roda-nucleo-ci.sh` num job bloqueante e
  // `gatesCandidatos` nao o viu — o cabecalho seguiu dizendo "28 gate(s)" e ninguem soube.
  it('o ci.yml de VERDADE: o nucleo SQL do #2364 esta fora do censo e DENTRO do contador', () => {
    expect(gatesCandidatos(ci).some((g) => /nucleo/.test(g.nome)), 'o censo nao o nomeia').toBe(false);
    const nucleo = bloqueantesOpacos(ci).find((o) => o.comando.includes('roda-nucleo-ci.sh'));
    expect(nucleo, 'o contador tem de ve-lo').toBeDefined();
    expect(nucleo!.job).toBe('provas-sql');
  });

  // O agregador do `validate` e o caso que so aparece depois de a RAIZ entrar em
  // `jobsBloqueantes`. Ele NAO e filtrado por nome de proposito: tem logica propria (guard de
  // denominador + guard nominal de `provas-sql`) e e exatamente o que este contador existe para
  // manter visivel. Se um dia alguem o silenciar por allowlist, este teste fica vermelho.
  it('o agregador do validate esta DENTRO do contador — nao ha filtro por nome', () => {
    const agregador = bloqueantesOpacos(ci).find((o) => o.job === 'validate');
    expect(agregador, 'o step do required check tem de aparecer').toBeDefined();
    expect(agregador!.step).toContain('Todos os jobs passaram');
  });

  // E o motivo de a conta de bloqueantes NAO ter mudado ao incluir a raiz: o `validate` nao
  // hospeda nenhum step que invoque script do package.json. Trava a razao, nao o numero — travar
  // o numero apodreceria a cada gate novo, que e o oposto do que esta maquina quer.
  it('o validate nao acrescenta gate NOMEADO ao censo (por isso o total nao mudou)', () => {
    expect(gatesCandidatos(ci).filter((g) => g.job === 'validate')).toEqual([]);
  });

  // A invariante que impede a FRESTA: censo e contador tem de PARTICIONAR os steps bloqueantes.
  // Se as duas pontas usassem regras diferentes para "tem nome de comando", um step poderia sumir
  // das DUAS listas — e aí o silencio voltaria, agora com dois numeros para dar-lhe cobertura.
  it('todo step bloqueante com `run` cai em EXATAMENTE uma das duas listas', () => {
    const doc = parse(ci) as { jobs?: Record<string, { steps?: unknown[] }> };
    const bloq = jobsBloqueantes(ci);
    const opacos = new Set(bloqueantesOpacos(ci).map((o) => `${o.job}\u0000${o.step}`));
    let vistos = 0;

    for (const [job, corpo] of Object.entries(doc.jobs ?? {})) {
      if (!bloq.has(job)) continue;
      for (const bruto of corpo?.steps ?? []) {
        const st = bruto as { name?: string; run?: unknown; 'continue-on-error'?: unknown };
        if (typeof st.run !== 'string' || st['continue-on-error'] === true) continue;
        vistos++;
        const chave = `${job}\u0000${st.name ?? '(sem nome)'}`;
        const noCenso = nomesDeScript(st.run).size > 0;
        expect(noCenso !== opacos.has(chave), `${chave} caiu nas duas listas ou em nenhuma`).toBe(true);
      }
    }
    expect(vistos, 'a varredura tem de ter olhado steps de verdade').toBeGreaterThan(10);
  });
});

describe('primeiraLinhaComCarne', () => {
  it('pula vazio, comentario e prologo de shell', () => {
    expect(primeiraLinhaComCarne('\n# comenta\nset -euo pipefail\nexport A=1\nbash x.sh')).toBe('bash x.sh');
  });

  it('so prologo devolve o prologo, nunca string vazia (presenca > silencio)', () => {
    expect(primeiraLinhaComCarne('set -euo pipefail')).toBe('set -euo pipefail');
  });

  it('trunca com reticencia dentro do limite', () => {
    expect(primeiraLinhaComCarne('bash '.repeat(30), 20)).toBe('bash bash bash ba...');
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

describe('fundirLinhas — medicao parcial nao pode APAGAR medicao anterior', () => {
  // O bug real, achado medindo: uma rodada com `--gates docs:*` substituiu a linha inteira de
  // `indice-orfao` e apagou a execucao do `test` medida antes. `docs:indice`, que a medicao com o
  // vitest tinha mostrado CO-PEGADO, reapareceu no relatorio como `[SO ELE]` — exclusividade
  // FABRICADA a partir de dado que existia e foi descartado.
  it('preserva execucao de gate que a rodada nova nao incluiu', () => {
    const antiga = linha({ execucoes: [exec('docs:indice', true), exec('test', true)] });
    const nova = linha({ execucoes: [exec('docs:indice', true)] });
    expect(fundirLinhas(antiga, nova).execucoes.map((e) => e.gate)).toEqual(['docs:indice', 'test']);
  });

  it('a execucao NOVA do mesmo gate vence a antiga', () => {
    const antiga = linha({ execucoes: [exec('g1', true, 111)] });
    const nova = linha({ execucoes: [exec('g1', false, 222)] });
    const [e] = fundirLinhas(antiga, nova).execucoes;
    expect([e.reprovou, e.ms]).toEqual([false, 222]);
  });

  // Conservador de proposito: o erro tolerado e deixar de reconhecer um exclusivo, nunca inventar.
  it('parouCedo propaga por OU — linha podada em qualquer rodada nunca vira exclusiva', () => {
    const antiga = linha({ execucoes: [exec('g1', true)], parouCedo: true });
    const nova = linha({ execucoes: [exec('g1', true)], parouCedo: false });
    expect(fundirLinhas(antiga, nova).parouCedo).toBe(true);
  });

  it('sem linha antiga, devolve a nova intacta', () => {
    const nova = linha({ execucoes: [exec('g1', true)] });
    expect(fundirLinhas(undefined, nova)).toEqual(nova);
  });

  // Duas camadas contra o mesmo exclusivo fabricado. A fusao preserva o CO-PEGADOR medido antes
  // (a linha tem 2 vermelhos: refutada). Sem a fusao, a linha parcial deixa g2 DESCONHECIDO — e a
  // exigencia de universo completo (G) a rebaixa para INCONCLUSIVA em vez de certificar.
  it('a fusao de fato IMPEDE o exclusivo fabricado (o cenario completo)', () => {
    const antiga = linha({ suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] });
    const parcial = linha({ suspeito: 'g1', execucoes: [exec('g1', true)] });
    const semFusao = derivar(matriz({ linhas: [parcial] })).find((e) => e.gate === 'g1')!;
    const comFusao = derivar(matriz({ linhas: [fundirLinhas(antiga, parcial)] })).find((e) => e.gate === 'g1')!;
    expect(semFusao.exclusivos, 'sem fusao: g2 desconhecido, nao certifica').toEqual([]);
    expect(semFusao.inconclusivos, 'sem fusao: e o que a linha parcial sabe dizer').toEqual(['d1']);
    expect(comFusao.exclusivos, 'com fusao: o co-pegador volta').toEqual([]);
    expect(comFusao.inconclusivos, 'com fusao: 2 vermelhos refutam, nao e inconclusivo').toEqual([]);
  });
});

describe('avaliar — severidade', () => {
  const g = (nome: string, bloqueiaPR = true): GateAlvo => ({ nome, linha: 1, step: 's', job: 'j', bloqueiaPR });
  const fp = new Map([['g1', { fingerprint: 'fp', resolvida: true }]]);

  it('matriz ausente reprova (fail-closed)', () => {
    const v = avaliar(lerMatriz(null), [g('g1')], fp);
    expect(v[0].severidade).toBe('REPROVA');
    expect(v[0].codigo).toBe('MATRIZ_AUSENTE');
  });

  // O objetivo declarado da maquina: quem acrescenta um gate paga a prova de que ele pega algo
  // que ninguem pega. Sem este teste, a ferramenta inteira e decorativa.
  it('gate bloqueante sem NENHUMA medicao reprova', () => {
    const v = avaliar(lida(matriz()), [g('novo')], new Map());
    expect(v.map((x) => x.codigo)).toContain('GATE_NOVO_SEM_EXCLUSIVIDADE');
    expect(v.find((x) => x.codigo === 'GATE_NOVO_SEM_EXCLUSIVIDADE')!.severidade).toBe('REPROVA');
  });

  // O defeito (2), na forma exata da matriz real de 2026-09-10: a poda parou no 2o vermelho e o
  // suspeito nunca rodou. `naoMedido` e a lista de onde ele NAO rodou — contar isso como medicao
  // aprovava o gate por ausencia de dado. O teste acima nao pega isso: sem linha nenhuma, a formula
  // velha e a nova concordam.
  it('gate que so aparece como NAO RODADO (podado) reprova — ausencia de execucao nao e medicao', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g2', execucoes: [exec('g1', true)], parouCedo: true })] });
    const v = avaliar(lida(m), [g('g1'), g('g2')], fp).find((x) => x.gate === 'g2' && x.codigo === 'GATE_NOVO_SEM_EXCLUSIVIDADE');
    expect(v?.severidade).toBe('REPROVA');
    expect(v?.motivo).toMatch(/NUNCA EXECUTADO/);
  });

  it('gate executado so em linha INVALIDA reprova — a linha invalida nao mediu nada', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', true)], invalido: 'gate g3 estourou' })] });
    const codigos = avaliar(lida(m), [g('g1'), g('g2')], fp).filter((x) => x.gate === 'g1').map((x) => x.codigo);
    expect(codigos).toContain('GATE_NOVO_SEM_EXCLUSIVIDADE');
  });

  it('gate EXECUTADO em linha valida conta como medido, mesmo verde — o preco e rodar, nao pegar', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', false), exec('g2', true)] })] });
    const codigos = avaliar(lida(m), [g('g1'), g('g2')], fp).filter((x) => x.gate === 'g1').map((x) => x.codigo);
    expect(codigos).not.toContain('GATE_NOVO_SEM_EXCLUSIVIDADE');
  });

  it('gate na lista de dispensados nao reprova — divida DECLARADA, visivel no diff', () => {
    const m = matriz({ dispensados: [{ gate: 'novo', desde: '2026-09-07', motivo: 'pre-existente' }] });
    expect(avaliar(lida(m), [g('novo')], new Map()).filter((v) => v.severidade === 'REPROVA')).toEqual([]);
  });

  it('gate INFORMATIVO nunca e cobrado (mutcheck e o caso real)', () => {
    expect(avaliar(lida(matriz()), [g('mutcheck', false)], new Map())).toEqual([]);
  });

  // Fabricacao no 3, e a mais cara: e a correcao no 1 do parecer do Codex. Corpus curto nao mede
  // gate raro; `docs:links` tem dez achados no proprio historico e mesmo assim nao apareceu numa
  // janela de 80 runs. Exclusividade zero INFORMA, nunca bloqueia.
  // O universo de `avaliar` sao os gates bloqueantes do ci.yml de HOJE — por isso os dois gates da
  // linha entram como candidatos: um g2 fora da lista seria um gate que nao existe mais, e ai g1
  // seria, corretamente, o unico que pega.
  it('exclusividade zero RELATA — jamais reprova', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] })] });
    const v = avaliar(lida(m), [g('g1'), g('g2')], fp);
    const zero = v.find((x) => x.codigo === 'EXCLUSIVIDADE_ZERO' && x.gate === 'g1')!;
    expect(zero.severidade).toBe('RELATA');
    expect(v.some((x) => x.severidade === 'REPROVA')).toBe(false);
  });

  it('o motivo do EXCLUSIVIDADE_ZERO carrega o DENOMINADOR (zero sem N le como "inutil")', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [exec('g1', true), exec('g2', true)] })] });
    const zero = avaliar(lida(m), [g('g1'), g('g2')], fp).find((x) => x.codigo === 'EXCLUSIVIDADE_ZERO' && x.gate === 'g1')!;
    expect(zero.motivo).toMatch(/de 1 defeito/);
    expect(zero.motivo).toMatch(/NAO e "nao pega nada"/);
  });

  it('zero SEM mira do corpus vira CORPUS_NAO_MIROU, nao EXCLUSIVIDADE_ZERO', () => {
    const m = matriz({
      linhas: [linha({ suspeito: 'outro', execucoes: [exec('g1', true), exec('g2', true)] })],
    });
    const v = avaliar(lida(m), [g('g1'), g('g2')], fp).filter((x) => x.gate === 'g1');
    expect(v.map((x) => x.codigo)).toContain('CORPUS_NAO_MIROU');
    expect(v.map((x) => x.codigo)).not.toContain('EXCLUSIVIDADE_ZERO');
    expect(v.find((x) => x.codigo === 'CORPUS_NAO_MIROU')!.motivo).toMatch(/mede o CORPUS, nao o gate/);
  });

  // "Outro gate tambem pegou" seria FALSO aqui: g2 nao reprovou — nao rodou. O unico vermelho de
  // uma linha incompleta nao e redundancia medida; e medicao que nao terminou.
  it('unico vermelho de linha INCOMPLETA relata INCONCLUSIVA, nunca EXCLUSIVIDADE_ZERO', () => {
    const m = matriz({ linhas: [linha({ suspeito: 'g1', execucoes: [exec('g1', true)] })] });
    const v = avaliar(lida(m), [g('g1'), g('g2')], fp).filter((x) => x.gate === 'g1');
    expect(v.map((x) => x.codigo)).toContain('EXCLUSIVIDADE_INCONCLUSIVA');
    expect(v.map((x) => x.codigo)).not.toContain('EXCLUSIVIDADE_ZERO');
    expect(v.find((x) => x.codigo === 'EXCLUSIVIDADE_INCONCLUSIVA')!.severidade).toBe('RELATA');
  });

  it('fonte mudada AVISA, nao reprova', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', true)] })] });
    const v = avaliar(lida(m), [g('g1')], new Map([['g1', { fingerprint: 'OUTRO', resolvida: true }]]));
    const podre = v.find((x) => x.codigo === 'LINHA_PODRE')!;
    expect(podre.severidade).toBe('AVISA');
  });

  it('frescor nao verificavel e DITO em voz alta, nao silenciado', () => {
    const m = matriz({ linhas: [linha({ execucoes: [exec('g1', true), exec('g2', true)] })] });
    const v = avaliar(lida(m), [g('g1')], new Map([['g1', { fingerprint: 'x', resolvida: false }]]));
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

// ---------------------------------------------------------------------------------------------
// A LEITURA da matriz e fail-closed (docs/historico/exclusividade-media-outra-coisa.md, "O achado
// de gate: ninguem valida `schemaVersion`"). O `SCHEMA_VERSION` era GRAVADO pelo motor e nunca
// conferido: uma matriz de outro schema era lida como a de hoje, e campo fora do lugar chegava como
// `undefined` no meio do veredito — TypeError (exit 2) ou, pior, veredito calculado sobre dado alheio.
// ---------------------------------------------------------------------------------------------

describe('lerMatriz — matriz de OUTRO schema, ou de forma invalida, e RECUSADA com codigo proprio', () => {
  /** O texto na serializacao do motor. */
  const texto = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
  /** Valida e com todo campo opcional preenchido — a forma tem o que conferir em cada nivel. */
  const cheia = (): Matriz =>
    matriz({
      dispensados: [{ gate: 'g2', desde: '2026-09-07', motivo: 'pre-existente' }],
      linhas: [
        linha({
          execucoes: [exec('g1', true), { ...exec('g2', false), invocacao: 'bun run g2' }],
          deveres: ['bump-versao fx'],
          tocados: ['supabase/functions/fx/versao.ts'],
          defasados: ['g2'],
        }),
      ],
    });
  /** `{codigo, motivo}` da recusa, ou `ACEITOU` — nenhuma assercao de recusa casa isso. */
  const recusa = (t: string | null) => {
    const l = lerMatriz(t);
    return l.ok ? { codigo: 'ACEITOU', motivo: '' } : { codigo: l.codigo, motivo: l.motivo };
  };
  const sem = (campo: keyof Matriz) => Object.fromEntries(Object.entries(cheia()).filter(([k]) => k !== campo));

  // O CONTROLE, na mesma execucao das recusas: uma leitura que recusasse TUDO aprovaria todas elas.
  it('CONTROLE: a matriz valida do schema de hoje e ACEITA, identica ao que foi gravado', () => {
    expect(lerMatriz(texto(cheia()))).toEqual({ ok: true, matriz: cheia() });
  });

  it('schemaVersion de OUTRA versao (futura ou passada) reprova MATRIZ_SCHEMA_INCOMPATIVEL', () => {
    for (const v of [SCHEMA_VERSION + 1, SCHEMA_VERSION - 1]) {
      const r = recusa(texto({ ...cheia(), schemaVersion: v }));
      expect(r.codigo, `schemaVersion ${v}`).toBe('MATRIZ_SCHEMA_INCOMPATIVEL');
      expect(r.motivo).toContain(`schemaVersion ${v}`);
      expect(r.motivo).toContain(`le schemaVersion ${SCHEMA_VERSION}`);
    }
  });

  it('schemaVersion AUSENTE, ou que nao e o numero, reprova MATRIZ_SCHEMA_INCOMPATIVEL — nunca "deve ser o de hoje"', () => {
    const ausente = recusa(texto(sem('schemaVersion')));
    expect(ausente.codigo).toBe('MATRIZ_SCHEMA_INCOMPATIVEL');
    expect(ausente.motivo).toContain('schemaVersion ausente');
    expect(recusa(texto({ ...cheia(), schemaVersion: String(SCHEMA_VERSION) })).codigo).toBe('MATRIZ_SCHEMA_INCOMPATIVEL');
  });

  it('campo OBRIGATORIO ausente reprova MATRIZ_MALFORMADA nomeando o campo', () => {
    for (const campo of ['medidoEm', 'sourceHead', 'dispensados', 'baseline', 'linhas'] as const) {
      const r = recusa(texto(sem(campo)));
      expect(r.codigo, campo).toBe('MATRIZ_MALFORMADA');
      expect(r.motivo, campo).toContain(`${campo} ausente`);
    }
  });

  // O pior caso do achado: tipo errado FUNDO na matriz nao lanca — ele vira "falsy = nao reprovou"
  // e o veredito sai calculado, calado. A forma e conferida ate a execucao.
  it('TIPO errado no fundo da matriz reprova MATRIZ_MALFORMADA com o caminho inteiro', () => {
    const doc = JSON.parse(texto(cheia()));
    doc.linhas[0].execucoes[1].reprovou = 'sim';
    const r = recusa(JSON.stringify(doc));
    expect(r.codigo).toBe('MATRIZ_MALFORMADA');
    expect(r.motivo).toContain('linhas[0].execucoes[1].reprovou');
  });

  it('opcional AUSENTE nao reprova — execucao anterior a paridade nao tem `invocacao`, e isso e o formato', () => {
    const doc = JSON.parse(texto(cheia()));
    delete doc.linhas[0].execucoes[1].invocacao;
    for (const k of ['deveres', 'tocados', 'defasados']) delete doc.linhas[0][k];
    expect(lerMatriz(JSON.stringify(doc)).ok).toBe(true);
  });

  it('raiz que nao e objeto reprova MATRIZ_MALFORMADA', () => {
    for (const t of ['[]', '42', '"x"', 'null']) expect(recusa(t).codigo, t).toBe('MATRIZ_MALFORMADA');
  });

  it('arquivo ausente e JSON ilegivel seguem MATRIZ_AUSENTE', () => {
    expect(recusa(null).codigo).toBe('MATRIZ_AUSENTE');
    expect(recusa('{ nao e json').codigo).toBe('MATRIZ_AUSENTE');
  });

  // O motivo e o que o operador e a suite do binario casam: ASCII imprimivel — sem acento, sem
  // travessao —, casavel sem `-i` em `LC_ALL=C` e em `pt_BR.UTF-8`.
  it('todo motivo de recusa e ASCII imprimivel', () => {
    const casos = [null, '{ nao e json', '[]', texto(sem('schemaVersion')), texto({ ...cheia(), schemaVersion: SCHEMA_VERSION + 1 }), texto({ ...cheia(), linhas: 'x' })];
    for (const t of casos) {
      const r = recusa(t);
      expect(r.codigo, String(t)).not.toBe('ACEITOU');
      expect(r.motivo, r.codigo).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('avaliar — leitura RECUSADA e um veredito, nunca uma excecao no meio do calculo', () => {
  const g = (nome: string): GateAlvo => ({ nome, linha: 1, step: 's', job: 'j', bloqueiaPR: true });

  // O defeito exato do achado: `m.dispensados.map` lancava TypeError nao tratado.
  it('matriz sem `dispensados` vira UMA REPROVA MATRIZ_MALFORMADA — nao TypeError', () => {
    const { dispensados: _, ...semDispensados } = matriz();
    const v = avaliar(lerMatriz(JSON.stringify(semDispensados)), [g('g1')], new Map());
    expect(v).toEqual([
      { severidade: 'REPROVA', gate: '(todos)', codigo: 'MATRIZ_MALFORMADA', motivo: expect.stringContaining('dispensados') },
    ]);
  });

  // Lida como a de hoje, a MESMA matriz daria GATE_NOVO_SEM_EXCLUSIVIDADE para `novo` — um veredito
  // calculado sobre dado de outro formato. Recusada, sai so a recusa.
  it('matriz de schema futuro vira UMA REPROVA MATRIZ_SCHEMA_INCOMPATIVEL — nenhum veredito calculado sobre ela', () => {
    const v = avaliar(lerMatriz(JSON.stringify(matriz({ schemaVersion: SCHEMA_VERSION + 1 }))), [g('novo')], new Map());
    expect(v).toEqual([
      {
        severidade: 'REPROVA',
        gate: '(todos)',
        codigo: 'MATRIZ_SCHEMA_INCOMPATIVEL',
        motivo: expect.stringContaining(`schemaVersion ${SCHEMA_VERSION + 1}`),
      },
    ]);
  });
});

describe('o BINARIO contra matriz recusada — exit 1 com o codigo, nunca exit 2 nem verde', () => {
  // HERMETICO de proposito: ci.yml, auto-merge e matriz SINTETICOS. Ler a matriz REAL aqui faria do
  // `test` uma segunda porta para `matriz-schema-futuro` (matriz.def), e o `exclusividade` perderia,
  // por construcao, o defeito que so ele pega.
  const CI_SINTETICO = 'jobs:\n  j:\n    steps:\n      - name: g\n        run: bun run lint\n  validate:\n    needs: [j]\n';
  const valida = () => matriz({ dispensados: [{ gate: 'lint', desde: 'fixture', motivo: 'o unico gate do ci sintetico' }] });
  const semLinhas = () => Object.fromEntries(Object.entries(valida()).filter(([k]) => k !== 'linhas'));
  const futura = () => ({ ...valida(), schemaVersion: SCHEMA_VERSION + 1 });
  let dir = '';
  let n = 0;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'excl-leitura-'));
    writeFileSync(join(dir, 'ci.yml'), CI_SINTETICO);
    writeFileSync(join(dir, 'auto-merge.yml'), '# mergeia quando o required check `validate` passa\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * `spawn` ASSINCRONO: `spawnSync` seguraria o event loop do worker pelo tempo do filho, e sob carga
   * os binarios seguidos passam dos 60s do RPC do vitest (exclusividade-medir.test.ts, `rodar`).
   */
  const contra = (doc: unknown, ...extra: string[]): Promise<{ status: number | null; stdout: string; saida: string }> => {
    const arq = join(dir, `matriz-${n++}.json`);
    writeFileSync(arq, `${JSON.stringify(doc, null, 2)}\n`);
    const argv = ['scripts/exclusividade-gate.ts', '--ci', join(dir, 'ci.yml'), '--auto-merge', join(dir, 'auto-merge.yml'), '--matriz', arq, ...extra];
    return new Promise((ok, falha) => {
      const filho = spawn('bun', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      filho.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      filho.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      filho.on('error', falha);
      filho.on('close', (status) => ok({ status, stdout, saida: `${stdout}${stderr}` }));
    });
  };

  // O CONTROLE, na MESMA execucao dos vermelhos: um gate que recusasse toda matriz aprovaria todos eles.
  it('CONTROLE: a matriz sintetica valida sai VERDE (exit 0), sem nenhum codigo de recusa', async () => {
    const r = await contra(valida());
    expect(r.status, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).not.toMatch(/MATRIZ_(AUSENTE|SCHEMA_INCOMPATIVEL|MALFORMADA)/);
  }, 60_000);

  it('schema FUTURO: exit 1 com REPROVA MATRIZ_SCHEMA_INCOMPATIVEL — nunca o veredito calculado sobre ela', async () => {
    const r = await contra(futura());
    expect(r.status, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toMatch(/REPROVA\s+\(todos\)\s+MATRIZ_SCHEMA_INCOMPATIVEL/);
  }, 60_000);

  // O TypeError do achado, visto de fora: `matriz.linhas.length` lancava e o gate saia 2.
  it('forma INVALIDA (sem `linhas`): exit 1 com REPROVA MATRIZ_MALFORMADA — nao o exit 2 de TypeError', async () => {
    const r = await contra(semLinhas());
    expect(r.status, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toMatch(/REPROVA\s+\(todos\)\s+MATRIZ_MALFORMADA/);
    expect(r.saida).not.toContain('erro do proprio gate');
  }, 60_000);

  it('--resumo tambem recusa (exit 2 com o codigo) — nunca o resumo de uma matriz de outro schema', async () => {
    const r = await contra(futura(), '--resumo');
    expect(r.status, r.saida.slice(-1500)).toBe(2);
    expect(r.saida).toContain('MATRIZ_SCHEMA_INCOMPATIVEL');
  }, 60_000);

  // A atencao (1) do achado, fechada com a saida DO BINARIO — nao um JSON escrito a mao: o
  // classificador do motor le as recusas de leitura como REPROVA-ALHEIA, vermelho que a rodada nao resolve.
  it('o --json do binario, lido pelo classificador do motor: REPROVA-ALHEIA, nunca excluivel', async () => {
    const casos = [
      [futura(), 'MATRIZ_SCHEMA_INCOMPATIVEL'],
      [semLinhas(), 'MATRIZ_MALFORMADA'],
    ] as const;
    for (const [doc, codigo] of casos) {
      const baseline = await contra(doc);
      const sonda = await contra(doc, '--json');
      const d = exclusividadeVermelhaSoPorGateNovo({
        rcBaseline: baseline.status,
        rcSonda: sonda.status,
        saidaSonda: sonda.stdout,
        gatesDaRodada: ['lint'],
      });
      expect(d.excluir ? 'EXCLUIU' : d.motivo, codigo).toMatch(new RegExp(`^REPROVA-ALHEIA ${codigo} `));
    }
  }, 120_000);
});

describe('o corpus de verdade', () => {
  const arquivos = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.def'));
  // Parse PREGUICOSO, dentro dos testes — nunca na coleta. O parser LANCA (dever de casa invalido ou
  // pendurado), e um lancamento na coleta derruba o arquivo inteiro com "no tests": os ~100 testes
  // somem junto com o sinal. Medido na falsificacao de 2026-09-10: rc=1 com ZERO testes executados.
  let cache: Defeito[] | null = null;
  const defeitos = (): Defeito[] =>
    (cache ??= arquivos.flatMap((f) => parseDefeitos(readFileSync(`${CORPUS_DIR}/${f}`, 'utf8'), f)));

  it('o corpus real PARSEIA — nenhum dever de casa invalido ou pendurado', () => {
    expect(() => defeitos()).not.toThrow();
  });

  // Guarda ANTI-VACUO: um glob que para de casar faria toda assercao abaixo passar por nao achar
  // NADA — verde por ausencia de dado, a mesma familia registrada em ci-testes-edge-deno.md.
  it('o corpus real tem defeitos (o gate nao passa a vazio)', () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(1);
    expect(defeitos().length).toBeGreaterThanOrEqual(5);
  });

  it('todo defeito tem alvo que EXISTE no repo — alvo morto nao mede nada', () => {
    for (const d of defeitos()) {
      expect(readFileSync(d.alvo, 'utf8').length, `${d.id}: alvo ${d.alvo}`).toBeGreaterThan(0);
    }
  });

  it('todo id e unico (id repetido sobrescreveria a linha da matriz)', () => {
    const ids = defeitos().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('todo defeito declara @suspeito e @origem — o relatorio confronta declarado x medido', () => {
    for (const d of defeitos()) {
      expect(d.suspeito, `${d.id} sem @suspeito`).not.toBeNull();
      expect(d.origem, `${d.id} sem @origem`).not.toBeNull();
    }
  });

  // O motor executa o suspeito fora da poda. Um nome com typo nao e executado por ninguem, e a
  // linha "mira" um gate que nao existe — o gate de verdade segue sem mira, calado.
  it('todo @suspeito nomeia um gate BLOQUEANTE do ci.yml (typo mira o vazio)', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const nomes = new Set(gatesCandidatos(ci).filter((g) => g.bloqueiaPR).map((g) => g.nome));
    for (const d of defeitos()) expect(nomes.has(d.suspeito!), `${d.id}: @suspeito ${d.suspeito}`).toBe(true);
  });
});

describe('[fora-da-rodada] exclusividadeVermelhaSoPorGateNovo — o unico vermelho de baseline que a propria rodada resolve', () => {
  const novo = (gate: string) => ({ severidade: 'REPROVA', gate, codigo: 'GATE_NOVO_SEM_EXCLUSIVIDADE', motivo: 'm' });
  const avisa = { severidade: 'AVISA', gate: 'g:b', codigo: 'LINHA_PODRE', motivo: 'm' };
  /** O que o gate imprime em `--json`, na forma de `exclusividade-gate.ts`. */
  const sonda = (vereditos: unknown[], ancoraQuebrada: unknown[] = []) =>
    JSON.stringify({ ancoraQuebrada, vereditos, opacos: [], naoReproduziveis: [], matrizPresente: true }, null, 2);
  type Leitura = Parameters<typeof exclusividadeVermelhaSoPorGateNovo>[0];
  const decidir = (over: Partial<Leitura> = {}) =>
    exclusividadeVermelhaSoPorGateNovo({
      rcBaseline: 1,
      rcSonda: 1,
      saidaSonda: sonda([novo('g:novo')]),
      gatesDaRodada: ['g:barato', 'g:novo'],
      ...over,
    });
  /** O motivo da recusa; `EXCLUIU` quando nao recusou — nenhuma assercao de recusa casa isso. */
  const recusa = (over: Partial<Leitura>) => {
    const d = decidir(over);
    return d.excluir ? 'EXCLUIU' : d.motivo;
  };

  // O caso VERDE, na mesma execucao das recusas: uma funcao que recusa TUDO aprovaria todas elas.
  it('vermelho SO por GATE_NOVO de gates desta rodada: exclui e nomeia os gates novos (AVISA/RELATA nao contam)', () => {
    const d = decidir({
      saidaSonda: sonda([novo('g:z'), avisa, novo('g:a'), { ...avisa, severidade: 'RELATA', codigo: 'EXCLUSIVIDADE_ZERO' }]),
      gatesDaRodada: ['g:a', 'g:b', 'g:z'],
    });
    expect(d).toEqual({ excluir: true, gatesNovos: ['g:a', 'g:z'] });
  });

  it('baseline que nao saiu 1 nao exclui — 2 e erro do proprio gate, null e sinal/estouro', () => {
    expect(recusa({ rcBaseline: 2 })).toMatch(/^RC-BASELINE /);
    expect(recusa({ rcBaseline: null })).toMatch(/^RC-BASELINE /);
  });

  it('sonda que nao saiu 1 nao exclui — as duas leituras do mesmo gate discordam', () => {
    expect(recusa({ rcSonda: 0 })).toMatch(/^RC-SONDA /);
    expect(recusa({ rcSonda: null })).toMatch(/^RC-SONDA /);
  });

  // O `bun run` de um script ausente tambem sai 1 — o que impede isso de passar e o JSON exigido.
  it('stdout da sonda que nao e JSON nao exclui', () => {
    expect(recusa({ saidaSonda: '' })).toMatch(/^SONDA-ILEGIVEL /);
    expect(recusa({ saidaSonda: 'error: Script not found "exclusividade"' })).toMatch(/^SONDA-ILEGIVEL /);
  });

  it('JSON fora do contrato nao exclui — inclusive severidade que o gate nao emite', () => {
    const fora = [
      'null',
      '[]',
      '{}',
      JSON.stringify({ ancoraQuebrada: [], vereditos: 'x' }),
      sonda([null]),
      sonda([{ ...novo('g:novo'), gate: 7 }]),
      // Ao LADO de um GATE_NOVO valido: sem a checagem, a severidade desconhecida seria so ignorada e
      // a exclusao PASSARIA — a assercao casa a marca do ramo, e o 'EXCLUIU' nao a casa.
      sonda([novo('g:novo'), { ...novo('g:barato'), severidade: 'BLOQUEIA' }]),
    ];
    for (const saidaSonda of fora) expect(recusa({ saidaSonda }), saidaSonda).toMatch(/^SONDA-FORA-DO-CONTRATO /);
  });

  it('ancora da raiz quebrada nao exclui, nem com GATE_NOVO na lista', () => {
    const saidaSonda = sonda([novo('g:novo')], [{ codigo: 'ANCORA_AUTO_MERGE_PERDIDA', motivo: 'm' }]);
    expect(recusa({ saidaSonda })).toMatch(/^ANCORA-QUEBRADA ANCORA_AUTO_MERGE_PERDIDA/);
  });

  it('exit 1 sem nenhuma REPROVA no JSON nao exclui — vermelho sem motivo legivel', () => {
    expect(recusa({ saidaSonda: sonda([avisa]) })).toMatch(/^SEM-REPROVA /);
  });

  it('REPROVA alheia a gate novo nao exclui — nem MATRIZ_AUSENTE, nem codigo futuro sobre gate da rodada', () => {
    const matrizAusente = { severidade: 'REPROVA', gate: '(todos)', codigo: 'MATRIZ_AUSENTE', motivo: 'm' };
    expect(recusa({ saidaSonda: sonda([novo('g:novo'), matrizAusente]) })).toMatch(/^REPROVA-ALHEIA MATRIZ_AUSENTE/);
    // Sobre gate DA rodada so este criterio segura a exclusao — o de "fora da rodada" nao a pegaria.
    const futura = { severidade: 'REPROVA', gate: 'g:barato', codigo: 'CODIGO_FUTURO', motivo: 'm' };
    expect(recusa({ saidaSonda: sonda([novo('g:novo'), futura]) })).toMatch(/^REPROVA-ALHEIA CODIGO_FUTURO/);
  });

  // As recusas de LEITURA (2026-09-25): a rodada so grava execucao — uma matriz de outro schema, ou
  // quebrada, continua recusada depois dela. Tira-la da rodada nunca a resolveria.
  it('matriz de OUTRO schema ou MALFORMADA e REPROVA alheia — sozinha ou ao lado de GATE_NOVO', () => {
    for (const codigo of ['MATRIZ_SCHEMA_INCOMPATIVEL', 'MATRIZ_MALFORMADA']) {
      const recusada = { severidade: 'REPROVA', gate: '(todos)', codigo, motivo: 'm' };
      expect(recusa({ saidaSonda: sonda([recusada]) }), codigo).toMatch(new RegExp(`^REPROVA-ALHEIA ${codigo} `));
      expect(recusa({ saidaSonda: sonda([novo('g:novo'), recusada]) }), codigo).toMatch(new RegExp(`^REPROVA-ALHEIA ${codigo} `));
    }
  });

  it('GATE_NOVO de gate FORA desta rodada nao exclui — a rodada nao grava a execucao que o resolveria', () => {
    expect(recusa({ gatesDaRodada: ['g:barato'] })).toMatch(/^GATE-NOVO-FORA-DA-RODADA g:novo/);
  });

  // Isolado do anterior de proposito: mesmo listado na rodada por quem chama, tirar o proprio gate
  // da rodada nunca grava a execucao que o livraria do GATE_NOVO.
  it('GATE_NOVO do PROPRIO exclusividade nao exclui, nem listado na rodada', () => {
    expect(recusa({ saidaSonda: sonda([novo('exclusividade')]), gatesDaRodada: ['exclusividade', 'g:barato'] })).toMatch(
      /^GATE-NOVO-E-O-PROPRIO /,
    );
  });
});

describe('[fora-da-rodada] celula DEFASADA — a execucao antiga do gate excluido conta como execucao, nunca como completude', () => {
  const U = ['exclusividade', 'g:a', 'g:novo'];
  const g = (nome: string): GateAlvo => ({ nome, linha: 1, step: 's', job: 'j', bloqueiaPR: true });
  const de = (m: Matriz, gate: string) => derivar(m, { universo: U }).find((e) => e.gate === gate)!;

  it('fundir numa rodada que EXCLUIU o gate: a celula antiga dele fica, marcada defasada', () => {
    const antiga = linha({ execucoes: [exec('exclusividade', false), exec('g:a', false)] });
    const nova = linha({ execucoes: [exec('g:a', false), exec('g:novo', true)] });
    const f = fundirLinhas(antiga, nova, ['exclusividade']);
    expect(f.execucoes.map((e) => e.gate)).toEqual(['exclusividade', 'g:a', 'g:novo']);
    expect(f.defasados).toEqual(['exclusividade']);
  });

  it('sem celula antiga do excluido nao ha o que marcar', () => {
    const f = fundirLinhas(linha({ execucoes: [exec('g:a', false)] }), linha({ execucoes: [exec('g:novo', true)] }), ['exclusividade']);
    expect(f.defasados).toBeUndefined();
  });

  it('rodada parcial que nao o executa MANTEM a marca; a que o executa a LIMPA', () => {
    const defasada = linha({
      execucoes: [exec('exclusividade', false), exec('g:a', false), exec('g:novo', true)],
      defasados: ['exclusividade'],
    });
    expect(fundirLinhas(defasada, linha({ execucoes: [exec('g:a', false)] })).defasados).toEqual(['exclusividade']);
    expect(fundirLinhas(defasada, linha({ execucoes: [exec('exclusividade', false)] })).defasados).toBeUndefined();
  });

  // O furo do parecer Codex, no sentido que mais importa: o gate NOVO certificado exclusivo com a
  // celula de um regime em que ele nem existia.
  it('verde DEFASADO do excluido + vermelho unico do gate novo: NAO certifica o novo', () => {
    const l = linha({
      execucoes: [exec('exclusividade', false), exec('g:a', false), exec('g:novo', true)],
      defasados: ['exclusividade'],
    });
    expect(de(matriz({ linhas: [{ ...l, defasados: undefined }] }), 'g:novo').exclusivos, 'controle: sem a marca a MESMA linha certifica').toEqual(['d1']);
    const comMarca = de(matriz({ linhas: [l] }), 'g:novo');
    expect(comMarca.exclusivos).toEqual([]);
    expect(comMarca.inconclusivos).toEqual(['d1']);
  });

  it('vermelho DEFASADO do proprio excluido tambem nao o certifica', () => {
    const l = linha({
      execucoes: [exec('exclusividade', true), exec('g:a', false), exec('g:novo', false)],
      defasados: ['exclusividade'],
    });
    expect(de(matriz({ linhas: [{ ...l, defasados: undefined }] }), 'exclusividade').exclusivos, 'controle').toEqual(['d1']);
    expect(de(matriz({ linhas: [l] }), 'exclusividade').exclusivos).toEqual([]);
  });

  // Descartar a celula em vez de marca-la: numa rodada do corpus inteiro o `exclusividade` ficaria
  // sem execucao valida e passaria a reprovar GATE_NOVO contra SI MESMO — impasse sem saida.
  it('celula defasada ainda e EXECUCAO: nao devolve o GATE_NOVO do proprio exclusividade', () => {
    const l = linha({ execucoes: [exec('exclusividade', false), exec('g:a', true)], defasados: ['exclusividade'] });
    const v = avaliar(lida(matriz({ linhas: [l] })), [g('exclusividade'), g('g:a')], new Map());
    expect(v.filter((x) => x.codigo === 'GATE_NOVO_SEM_EXCLUSIVIDADE').map((x) => x.gate)).toEqual([]);
    expect(de(matriz({ linhas: [l] }), 'exclusividade').rodou).toEqual(['d1']);
  });
});

describe('a CLASSE — `as Matriz` fora da porta unica', () => {
  // `JSON.parse(...) as Matriz` le uma matriz de outro schema como se fosse a de hoje: o defeito que o
  // gate E o motor tinham (2026-09-25). `lerMatriz` confere versao e forma; um leitor novo com cast
  // reabre a classe calado — os testes de comportamento acima so vigiam os dois leitores que existem.
  const fontes = () =>
    readdirSync('scripts', { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join('scripts', f));

  it('nenhum script faz cast para `Matriz` — a matriz so nasce de `lerMatriz`', () => {
    const comCast = fontes().filter((f) => /\bas\s+Matriz\b/.test(removerComentarios(readFileSync(f, 'utf8'))));
    expect(comCast).toEqual([]);
  });

  // Sem este, o scan acima passaria por CEGUEIRA: glob que parou de casar, ou limpeza que comeu o codigo.
  it('SENTINELA: o scan enxerga os dois leitores, e os dois passam pela porta', () => {
    const lista = fontes();
    for (const f of ['scripts/exclusividade-gate.ts', 'scripts/exclusividade-medir.ts']) {
      expect(lista, f).toContain(f);
      expect(removerComentarios(readFileSync(f, 'utf8')), f).toMatch(/\blerMatriz\(/);
    }
  });
});
