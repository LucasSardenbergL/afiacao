/**
 * Suite do MOTOR — com efeitos, contra o BINARIO real, num repo-fixture descartavel.
 *
 * A suite de `exclusividade-gate.test.ts` prova a logica pura. O que so o motor faz — rodar a
 * invocacao do CI, vigiar a arvore, executar o suspeito fora da poda, aplicar o dever de casa e
 * restaurar tudo — so se prova rodando o processo. O fixture imita o caso que originou tudo isto
 * (2026-09-10): um gate de BYTES que pega qualquer mudanca na edge (`sonda:bump`), um que exige o
 * mapa regenerado (`sonda:fingerprint`) e um gate SEMANTICO lento (`g:lento`, o `sonda:autentica`
 * do fixture) que a poda por custo deixava de fora.
 *
 * Todo cenario que exige vermelho tem o CONTROLE verde na mesma suite: o fixture sem o gate
 * escritor mede limpo; o gate de argumentos reprova quando rodado cru.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Matriz } from './lib/exclusividade';

const MOTOR = resolve('scripts/exclusividade-medir.ts');
const EDGE = 'supabase/functions/fx/index.ts';
const VERSAO = 'supabase/functions/fx/versao.ts';
const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';

/** Os gates do fixture. Cada modo e o analogo minimo de um gate real. */
const GATES_TS = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const modo = process.argv[2];
const edge = readFileSync('${EDGE}', 'utf8');
const dormir = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const mudou = (p: string) => spawnSync('git', ['diff', '--quiet', 'HEAD', '--', p]).status !== 0;
const impressao = () => createHash('sha256').update(edge + readFileSync('${VERSAO}', 'utf8')).digest('hex');
switch (modo) {
  case 'barato': process.exit(0);
  case 'lento': dormir(900); process.exit(edge.includes('SABOTADO') ? 1 : 0);
  case 'args': process.exit(process.argv.includes('--modo-ci') ? 0 : 3);
  case 'env': process.exit(process.env.MODO_FIXTURE === 'ci' ? 0 : 4);
  case 'bump': process.exit(mudou('${EDGE}') && !mudou('${VERSAO}') ? 1 : 0);
  case 'fingerprint': {
    if (process.argv.includes('--write')) {
      if (edge.includes('QUEBRA-GERADOR')) process.exit(7);
      if (edge.includes('VAZA')) writeFileSync('escrito.txt', 'o gerador vazou\\n');
      if (edge.includes('MEXE-NO-ALVO')) writeFileSync('${EDGE}', edge + '// vira codigo morto\\n');
      writeFileSync('${MAPA}', impressao() + '\\n');
      process.exit(0);
    }
    process.exit(readFileSync('${MAPA}', 'utf8').trim() === impressao() ? 0 : 1);
  }
  case 'escritor': appendFileSync('escrito.txt', 'x\\n'); process.exit(0);
  case 'escritor-sob-defeito': if (edge.includes('SABOTADO')) appendFileSync('escrito.txt', 'x\\n'); process.exit(0);
}
process.exit(9);
`;

const SCRIPTS: Record<string, string> = {
  'g:barato': 'bun scripts/g.ts barato',
  'g:lento': 'bun scripts/g.ts lento',
  'g:args': 'bun scripts/g.ts args',
  'g:env': 'bun scripts/g.ts env',
  'sonda:bump': 'bun scripts/g.ts bump',
  'sonda:fingerprint': 'bun scripts/g.ts fingerprint',
  'g:escritor': 'bun scripts/g.ts escritor',
  'g:escritor-sob-defeito': 'bun scripts/g.ts escritor-sob-defeito',
};

const PASSO: Record<string, string> = {
  'g:barato': 'run: bun run g:barato',
  'g:lento': 'run: bun run g:lento',
  // Paridade: sem o `-- --modo-ci` e sem o env do step, estes dois reprovam no baseline.
  'g:args': 'run: bun run g:args -- --modo-ci',
  'g:env': 'run: bun run g:env\n        env:\n          MODO_FIXTURE: ci',
  'sonda:bump': 'run: bun run sonda:bump',
  'sonda:fingerprint': 'run: bun run sonda:fingerprint',
  'g:escritor': 'run: bun run g:escritor',
  'g:escritor-sob-defeito': 'run: bun run g:escritor-sob-defeito',
};

const PADRAO = ['g:barato', 'g:lento', 'g:args', 'g:env', 'sonda:bump', 'sonda:fingerprint'];

const DEFS_PADRAO = `
# @origem: fixture
# @suspeito: g:lento
descuidado | ${EDGE} | s/^original$/SABOTADO/

# @dever-de-casa: bump-versao fx
# @dever-de-casa: regenerar-fingerprints
diligente | ${EDGE} | s/^original$/SABOTADO/

# @dever-de-casa: bump-versao fx
so-bump | ${EDGE} | s/^original$/SABOTADO/

# @dever-de-casa: regenerar-fingerprints
dever-sem-efeito | supabase/functions/fx/outro.ts | s/^nada$/SABOTADO/

# @dever-de-casa: regenerar-fingerprints
gerador-quebra | ${EDGE} | s/^original$/QUEBRA-GERADOR/
`;

const raizes: string[] = [];
afterAll(() => {
  for (const r of raizes) rmSync(r, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string, argv: string[]) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Commit do fixture sem herdar hook, assinatura ou identidade da maquina de quem roda. */
const commitar = (raiz: string, ...argv: string[]) =>
  sh(raiz, 'git', ['-c', 'user.name=f', '-c', 'user.email=f@f', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-q', ...argv]);

function montarFixture(gates: string[], defs: string): string {
  const raiz = mkdtempSync(join(tmpdir(), 'excl-motor-'));
  raizes.push(raiz);
  const arquivos: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: SCRIPTS }, null, 2),
    'scripts/g.ts': GATES_TS,
    '.github/workflows/ci.yml': `jobs:\n  j:\n    steps:\n${gates
      .map((g) => `      - name: ${g}\n        ${PASSO[g]}`)
      .join('\n')}\n  validate:\n    needs: [j]\n`,
    'scripts/exclusividade.d/x.def': defs,
    [EDGE]: 'linha 1\noriginal\nlinha 3\n',
    [VERSAO]: 'export const VERSAO = "v1.0-fx";\n',
    'supabase/functions/fx/outro.ts': 'nada\n',
    [MAPA]: 'provisorio — regravado pelo gerador abaixo\n',
    'escrito.txt': 'original\n',
  };
  for (const [p, c] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(raiz, p)), { recursive: true });
    writeFileSync(join(raiz, p), c);
  }
  sh(raiz, 'git', ['init', '-q']);
  // O mapa nasce do proprio gerador do fixture, como o real nasce do `--write`.
  sh(raiz, 'bun', ['run', 'sonda:fingerprint', '--', '--write']);
  sh(raiz, 'git', ['add', '-A']);
  commitar(raiz, '-m', 'fixture');
  return raiz;
}

function medir(raiz: string, argv: string[] = []) {
  const r = spawnSync('bun', [MOTOR, ...argv], { cwd: raiz, encoding: 'utf8', env: { ...process.env, EXCL_TIMEOUT_MS: '60000' } });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: raiz, encoding: 'utf8' }).stdout;
  return { rc: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}`, status };
}

const lerMatriz = (raiz: string) => JSON.parse(readFileSync(join(raiz, 'scripts/exclusividade-matriz.json'), 'utf8')) as Matriz;

describe('motor — a rodada limpa (o CONTROLE de todos os cenarios de aborto abaixo)', () => {
  let raiz = '';
  let r = { rc: null as number | null, saida: '', status: '' };
  let m: Matriz | null = null;
  beforeAll(() => {
    raiz = montarFixture(PADRAO, DEFS_PADRAO);
    r = medir(raiz);
    m = r.rc === 0 ? lerMatriz(raiz) : null;
  }, 180_000);
  const linha = (id: string) => m?.linhas.find((l) => l.defeito === id);
  const execDe = (id: string, gate: string) => linha(id)?.execucoes.find((e) => e.gate === gate);

  it('mede ate o fim (rc 0) e devolve a arvore INTACTA — so a matriz fica nova', () => {
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.status.trim()).toBe('?? scripts/exclusividade-matriz.json');
  });

  // Paridade de invocacao: o CONTROLE e o proprio gate reprovando quando rodado cru — sem ele,
  // "o baseline ficou verde" nao provaria que o motor passou os argumentos.
  it('roda a invocacao do CI: g:args e g:env ficam verdes no baseline, e reprovam quando crus', () => {
    expect(spawnSync('bun', ['run', 'g:args'], { cwd: raiz }).status, 'controle: cru reprova').toBe(3);
    expect(spawnSync('bun', ['run', 'g:env'], { cwd: raiz }).status, 'controle: sem env reprova').toBe(4);
    expect(m?.baseline.filter((b) => ['g:args', 'g:env'].includes(b.gate)).every((b) => b.verde)).toBe(true);
    // Na linha diligente, e nao na podada: so ela roda o universo inteiro POR CONSTRUCAO — na
    // podada, quem chega a rodar depende da ordem por custo, que e ruido de milissegundo.
    expect(execDe('diligente', 'g:args')?.invocacao).toBe('bun run g:args -- --modo-ci');
    expect(execDe('diligente', 'g:env')?.invocacao).toBe('env{MODO_FIXTURE=ci} bun run g:env');
  });

  // O defeito (2): a poda parava no 2o vermelho (os gates de BYTES, baratos) e o suspeito, caro,
  // nunca rodava — e mesmo assim contava como "medido".
  it('o suspeito podado RODA fora da poda, e a linha continua podada', () => {
    expect(linha('descuidado')?.parouCedo).toBe(true);
    expect(execDe('descuidado', 'g:lento')?.reprovou, 'o suspeito executou e pegou').toBe(true);
    expect(r.saida).toContain('suspeito, rodado FORA da poda');
  });

  // O defeito (3): com o dever de casa, os gates de bytes ficam verdes e SO o semantico pega — e a
  // linha rodou o universo inteiro, entao isso CERTIFICA, em vez de ficar inconclusivo.
  it('o autor DILIGENTE: bump + mapa regenerado deixam so o gate semantico vermelho', () => {
    const l = linha('diligente')!;
    expect(l.invalido, l.invalido ?? '').toBeNull();
    expect(l.deveres).toEqual(['bump-versao fx', 'regenerar-fingerprints']);
    expect(l.tocados).toEqual([MAPA, VERSAO].sort());
    expect(l.execucoes.filter((e) => e.reprovou).map((e) => e.gate)).toEqual(['g:lento']);
    expect(l.execucoes.map((e) => e.gate).sort()).toEqual([...PADRAO].sort());
    expect(r.saida).toMatch(/\[SO ELE\]\s+g:lento/);
  });

  it('meio dever de casa (so o bump) ainda e pego pelo mapa — o formato distingue os dois fluxos', () => {
    const l = linha('so-bump')!;
    expect(l.tocados).toEqual([VERSAO]);
    expect(execDe('so-bump', 'sonda:bump')?.reprovou).toBe(false);
    expect(execDe('so-bump', 'sonda:fingerprint')?.reprovou).toBe(true);
  });

  it('dever de casa que nao muda nada e INVALIDO — nunca o autor descuidado com nome de diligente', () => {
    expect(linha('dever-sem-efeito')?.invalido).toMatch(/NAO alterou nada/);
    expect(linha('dever-sem-efeito')?.execucoes).toEqual([]);
  });

  it('dever de casa que falha e INVALIDO', () => {
    expect(linha('gerador-quebra')?.invalido).toMatch(/falhou: saiu 7/);
  });
});

describe('motor — WRITE-GUARD: gate que escreve na arvore versionada aborta a rodada', () => {
  it('no BASELINE: aborta nomeando o gate e o arquivo, restaura, e NAO grava matriz', () => {
    const raiz = montarFixture([...PADRAO, 'g:escritor'], DEFS_PADRAO);
    const r = medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('g:escritor');
    expect(r.saida).toContain('escrito.txt');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
    expect(readFileSync(join(raiz, 'escrito.txt'), 'utf8')).toBe('original\n');
  }, 120_000);

  // `--sem-poda`: sob a poda, o 2o vermelho barato poderia parar a linha ANTES do escritor, e o
  // teste passaria a depender de ruido de milissegundo na ordem por custo.
  it('na MEDICAO: gate que so escreve sob o defeito tambem aborta, e o alvo sabotado volta', () => {
    const raiz = montarFixture([...PADRAO, 'g:escritor-sob-defeito'], DEFS_PADRAO);
    const r = medir(raiz, ['--defeitos', 'descuidado', '--sem-poda']);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('o defeito descuidado');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
    expect(readFileSync(join(raiz, EDGE), 'utf8')).toBe('linha 1\noriginal\nlinha 3\n');
  }, 120_000);

  it('receita que escreve FORA das saidas declaradas aborta (o gerador "vazou")', () => {
    const defs = `# @origem: f\n# @suspeito: g:lento\n# @dever-de-casa: regenerar-fingerprints\nvaza | ${EDGE} | s/^original$/VAZA/\n`;
    const raiz = montarFixture(PADRAO, defs);
    const r = medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('DEVER-DE-CASA-ESCREVEU-FORA');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
  }, 120_000);

  // O parecer do Codex: presenca textual da sabotagem nao prova persistencia — ela pode virar
  // codigo morto sem sair do arquivo. Por isso o ALVO inteiro e intocavel pela receita.
  it('receita que mexe no ALVO aborta — o defeito medido tem de ser o declarado, byte a byte', () => {
    const defs = `# @origem: f\n# @suspeito: g:lento\n# @dever-de-casa: regenerar-fingerprints\nmexe | ${EDGE} | s/^original$/MEXE-NO-ALVO/\n`;
    const raiz = montarFixture(PADRAO, defs);
    const r = medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('DEVER-DE-CASA-ESCREVEU-FORA');
    expect(r.saida).toContain(EDGE);
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
  }, 120_000);
});

describe('motor — o que aborta ANTES de gastar o baseline', () => {
  it('@suspeito que nao e gate bloqueante (typo) aborta', () => {
    const raiz = montarFixture(PADRAO, `# @origem: f\n# @suspeito: g:lentoo\nd | ${EDGE} | s/^original$/SABOTADO/\n`);
    const r = medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('SUSPEITO-DESCONHECIDO');
  }, 60_000);

  it('step composto no ci.yml aborta com INVOCACAO-NAO-REPRODUZIVEL', () => {
    const raiz = montarFixture(PADRAO, DEFS_PADRAO);
    const ci = join(raiz, '.github/workflows/ci.yml');
    writeFileSync(ci, readFileSync(ci, 'utf8').replace('run: bun run g:barato', "run: 'bun run g:barato || true'"));
    commitar(raiz, '-am', 'composto');
    const r = medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('INVOCACAO-NAO-REPRODUZIVEL');
  }, 60_000);
});
