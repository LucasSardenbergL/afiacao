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
 *
 * O ultimo bloco roda o gate `exclusividade` REAL dentro do fixture: a sonda `--json` que o motor
 * interpreta e a do binario de verdade, e o laco fecha POR FORA do motor — o mesmo gate, lendo a
 * matriz que a rodada gravou, volta a verde.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExecucaoGate, Matriz } from './lib/exclusividade';

const MOTOR = resolve('scripts/exclusividade-medir.ts');
const GATE_REAL = resolve('scripts/exclusividade-gate.ts');
const EDGE = 'supabase/functions/fx/index.ts';
const VERSAO = 'supabase/functions/fx/versao.ts';
const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';
const MATRIZ = 'scripts/exclusividade-matriz.json';

/** Os gates do fixture. Cada modo e o analogo minimo de um gate real. */
const GATES_TS = `
import { appendFileSync, existsSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
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
  case 'pega': process.exit(edge.includes('SABOTADO') ? 1 : 0);
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
  // Guarda 12: a forma MEDIDA do 'vitest run' sob contencao — resumo inteiro, zero teste
  // falhando, e o RPC do worker como unico erro. O denominador passa o piso anti-truncamento.
  case 'rpc-flaky':
  case 'rpc-sempre':
  case 'rpc-sob-defeito':
  case 'rpc-com-falha': {
    const resumo = (falhou: boolean) =>
      ' Test Files  ' + (falhou ? '1 failed | 841 passed (842)' : '842 passed (842)') + '\\n' +
      '      Tests  ' + (falhou ? '1 failed | 9255 passed (9256)' : '9256 passed (9256)') + '\\n' +
      '     Errors  1 error\\n';
    const corpo = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"\\n';
    const verdeLimpo = () => { writeFileSync(1, ' Test Files  842 passed (842)\\n      Tests  9256 passed (9256)\\n'); process.exit(0); };
    if (modo === 'rpc-com-falha') { writeFileSync(1, resumo(true)); writeFileSync(2, corpo); process.exit(1); }
    if (modo === 'rpc-sempre') { writeFileSync(1, resumo(false)); writeFileSync(2, corpo); process.exit(1); }
    if (modo === 'rpc-sob-defeito') {
      if (!readFileSync('supabase/functions/fx/outro.ts', 'utf8').includes('SABOTADO')) verdeLimpo();
      writeFileSync(1, resumo(false)); writeFileSync(2, corpo); process.exit(1);
    }
    // flaky: so a PRIMEIRA execucao estoura o RPC. O contador vive FORA da arvore (write-guard).
    const contador = process.env.RPC_CONTADOR as string;
    const n = existsSync(contador) ? Number(readFileSync(contador, 'utf8')) : 0;
    writeFileSync(contador, String(n + 1));
    if (n === 0) { writeFileSync(1, resumo(false)); writeFileSync(2, corpo); process.exit(1); }
    verdeLimpo();
    break;
  }
  case 'escritor': appendFileSync('escrito.txt', 'x\\n'); process.exit(0);
  case 'escritor-sob-defeito': if (edge.includes('SABOTADO')) appendFileSync('escrito.txt', 'x\\n'); process.exit(0);
  case 'quebrado': process.exit(5);
  // A CAPTURA do motor, vista de DENTRO do gate: com pipe o fd 1/2 e um FIFO, com
  // redirecionamento e um arquivo regular (que nunca bloqueia por leitor lento). Fica VERMELHO
  // no baseline se QUALQUER das duas pontas for pipe — e a cauda diz qual delas era.
  case 'canal': {
    const tipo = (fd: number) => { const st = fstatSync(fd); return st.isFIFO() ? 'FIFO' : st.isFile() ? 'ARQUIVO' : 'OUTRO'; };
    const [o, e] = [tipo(1), tipo(2)];
    writeFileSync(1, 'canal stdout=' + o + ' stderr=' + e + '\\n');
    process.exit(o === 'ARQUIVO' && e === 'ARQUIVO' ? 0 : 1);
  }
  case 'sonda-escreve': if (process.argv.includes('--json')) appendFileSync('escrito.txt', 'x\\n'); process.exit(1);
  // Um exclusividade de mentira cujo JSON diz "so GATE_NOVO de g:novo" — so o EXIT discorda.
  case 'excl-2-e-json':
  case 'excl-sonda-0': {
    const json = JSON.stringify({ ancoraQuebrada: [], vereditos: [{ severidade: 'REPROVA', gate: 'g:novo', codigo: 'GATE_NOVO_SEM_EXCLUSIVIDADE', motivo: 'fixture' }] });
    if (process.argv.includes('--json')) { writeFileSync(1, json + '\\n'); process.exit(modo === 'excl-2-e-json' ? 1 : 0); }
    process.exit(modo === 'excl-2-e-json' ? 2 : 1);
  }
  // Sonda LEGITIMA que tambem fala no stderr. Se o motor entregar UM fd para os dois canais, o
  // ruido entra no stdout, o JSON.parse morre e a exclusao vira SONDA-ILEGIVEL.
  case 'excl-sonda-ruidosa': {
    const json = JSON.stringify({ ancoraQuebrada: [], vereditos: [{ severidade: 'REPROVA', gate: 'g:novo', codigo: 'GATE_NOVO_SEM_EXCLUSIVIDADE', motivo: 'fixture' }] });
    if (process.argv.includes('--json')) {
      writeFileSync(2, 'RUIDO-DE-STDERR antes do JSON\\n');
      writeFileSync(1, json + '\\n');
      writeFileSync(2, 'RUIDO-DE-STDERR depois do JSON\\n');
    }
    process.exit(1);
  }
}
process.exit(9);
`;

const SCRIPTS: Record<string, string> = {
  'g:barato': 'bun scripts/g.ts barato',
  'g:lento': 'bun scripts/g.ts lento',
  'g:pega': 'bun scripts/g.ts pega',
  'g:pega2': 'bun scripts/g.ts pega',
  'g:args': 'bun scripts/g.ts args',
  'g:env': 'bun scripts/g.ts env',
  'sonda:bump': 'bun scripts/g.ts bump',
  'sonda:fingerprint': 'bun scripts/g.ts fingerprint',
  'g:escritor': 'bun scripts/g.ts escritor',
  'g:escritor-sob-defeito': 'bun scripts/g.ts escritor-sob-defeito',
  'g:novo': 'bun scripts/g.ts barato',
  'g:quebrado': 'bun scripts/g.ts quebrado',
  'g:canal': 'bun scripts/g.ts canal',
  'g:rpc-flaky': 'bun scripts/g.ts rpc-flaky',
  'g:rpc-sempre': 'bun scripts/g.ts rpc-sempre',
  'g:rpc-sob-defeito': 'bun scripts/g.ts rpc-sob-defeito',
  'g:rpc-com-falha': 'bun scripts/g.ts rpc-com-falha',
  // O gate REAL, lendo a matriz do fixture: a sonda `--json` que o motor interpreta e a do binario.
  exclusividade: `bun ${JSON.stringify(GATE_REAL)}`,
};

const PASSO: Record<string, string> = {
  'g:barato': 'run: bun run g:barato',
  'g:lento': 'run: bun run g:lento',
  'g:pega': 'run: bun run g:pega',
  'g:pega2': 'run: bun run g:pega2',
  // Paridade: sem o `-- --modo-ci` e sem o env do step, estes dois reprovam no baseline.
  'g:args': 'run: bun run g:args -- --modo-ci',
  'g:env': 'run: bun run g:env\n        env:\n          MODO_FIXTURE: ci',
  'sonda:bump': 'run: bun run sonda:bump',
  'sonda:fingerprint': 'run: bun run sonda:fingerprint',
  'g:escritor': 'run: bun run g:escritor',
  'g:escritor-sob-defeito': 'run: bun run g:escritor-sob-defeito',
  'g:novo': 'run: bun run g:novo',
  'g:quebrado': 'run: bun run g:quebrado',
  'g:canal': 'run: bun run g:canal',
  'g:rpc-flaky': 'run: bun run g:rpc-flaky',
  'g:rpc-sempre': 'run: bun run g:rpc-sempre',
  'g:rpc-sob-defeito': 'run: bun run g:rpc-sob-defeito',
  'g:rpc-com-falha': 'run: bun run g:rpc-com-falha',
  exclusividade: 'run: bun run exclusividade',
};

/**
 * O universo da RODADA LIMPA, o bloco que prova a poda por CUSTO: o `g:lento` (900ms) e o suspeito
 * caro que essa ordem poe atras dos gates de bytes — e so por isso a poda para antes dele e o
 * "suspeito podado RODA fora da poda" tem o que provar. Cenario que nao mede poda usa o ENXUTO.
 */
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

/**
 * Conjunto ENXUTO: para os cenarios cujo assunto NAO e a poda (guarda 12, write-guard). Com o PADRAO,
 * cada um pagava 1-2 sonos de 900ms do `g:lento` sem asserir nada sobre ordem. O `g:pega` e o
 * `g:lento` sem o sono — reprova no mesmo `SABOTADO` —, entao assume o papel de `@suspeito`.
 */
const ENXUTO = ['g:barato', 'g:pega'];
const DEFS_ENXUTO = `
# @origem: fixture
# @suspeito: g:pega
descuidado | ${EDGE} | s/^original$/SABOTADO/
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

const ciYml = (gates: string[]) =>
  `jobs:\n  j:\n    steps:\n${gates.map((g) => `      - name: ${g}\n        ${PASSO[g]}`).join('\n')}\n  validate:\n    needs: [j]\n`;

function montarFixture(gates: string[], defs: string): string {
  const raiz = mkdtempSync(join(tmpdir(), 'excl-motor-'));
  raizes.push(raiz);
  const arquivos: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: SCRIPTS }, null, 2),
    'scripts/g.ts': GATES_TS,
    '.github/workflows/ci.yml': ciYml(gates),
    // A 2a ponta da ancora da raiz: sem ela o `exclusividade` REAL reprova por ANCORA em qualquer cenario.
    '.github/workflows/auto-merge.yml': '# mergeia quando o required check `validate` passa\n',
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

function medir(raiz: string, argv: string[] = [], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, EXCL_TIMEOUT_MS: '60000', ...extraEnv };
  const r = spawnSync('bun', [MOTOR, ...argv], { cwd: raiz, encoding: 'utf8', env });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: raiz, encoding: 'utf8' }).stdout;
  return { rc: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}`, status };
}

const lerMatriz = (raiz: string) => JSON.parse(readFileSync(join(raiz, MATRIZ), 'utf8')) as Matriz;

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

describe('motor — guarda 12: vermelho SEM teste falhando nao e reprova, e a repeticao tem orcamento 1', () => {
  /**
   * O contador do `rpc-flaky` vive FORA da arvore — dentro dela o write-guard abortaria a rodada.
   * O diretorio entra em `raizes` como os fixtures: sem isso cada rodada deixava um `excl-rpc-*` no tmp.
   */
  const contador = () => {
    const dir = mkdtempSync(join(tmpdir(), 'excl-rpc-'));
    raizes.push(dir);
    return join(dir, 'n');
  };

  it('BASELINE: RPC na 1a e rc=0 limpo na 2a => VERDE, e a rodada mede ate o fim', () => {
    const raiz = montarFixture([...ENXUTO, 'g:rpc-flaky'], DEFS_ENXUTO);
    const r = medir(raiz, ['--defeitos', 'descuidado'], { RPC_CONTADOR: contador() });
    expect(r.saida).toContain('repetindo UMA vez');
    expect(r.saida).toContain('a repeticao saiu 0 limpo');
    expect(r.rc).toBe(0);
    expect(r.saida).not.toContain('BASELINE-SEM-DADO');
    expect(lerMatriz(raiz).baseline.find((b) => b.gate === 'g:rpc-flaky')?.verde).toBe(true);
  });

  it('BASELINE: RPC nas DUAS execucoes => BASELINE-SEM-DADO, e NAO "ja vermelho" — nada e gravado', () => {
    const raiz = montarFixture([...ENXUTO, 'g:rpc-sempre'], DEFS_ENXUTO);
    const r = medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('BASELINE-SEM-DADO');
    expect(r.saida).toContain('g:rpc-sempre');
    expect(r.saida).not.toContain('ja vermelho(s) no repo limpo');
    expect(existsSync(join(raiz, MATRIZ))).toBe(false);
    expect(r.status).toBe('');
  });

  it('FALSIFICACAO: um teste falhando JUNTO do RPC continua VERMELHO — a guarda nao engole reprova', () => {
    const raiz = montarFixture([...ENXUTO, 'g:rpc-com-falha'], DEFS_ENXUTO);
    const r = medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('ja vermelho(s) no repo limpo');
    expect(r.saida).toContain('g:rpc-com-falha');
    expect(r.saida).not.toContain('BASELINE-SEM-DADO');
    expect(r.saida).not.toContain('repetindo UMA vez');
  });

  it('SOB DEFEITO nao se repete: suspeito invalida a LINHA — nunca um verde que apagaria a deteccao', () => {
    // Defeito que NENHUM outro gate do fixture pega: sem isso a poda por custo (ruidosa entre gates
    // rapidos) decidiria se o gate do RPC chega a rodar, e o teste mediria a ordenacao, nao a guarda.
    const defs = `\n# @origem: fixture\n# @suspeito: g:rpc-sob-defeito\nso-rpc | supabase/functions/fx/outro.ts | s/^nada$/SABOTADO/\n`;
    const raiz = montarFixture([...ENXUTO, 'g:rpc-sob-defeito'], defs);
    const r = medir(raiz);
    expect(r.rc).toBe(0);
    // A repeticao e EXCLUSIVA do baseline: sob defeito o motor nao gasta a 2a execucao.
    expect(r.saida).not.toContain('repetindo UMA vez');
    expect(r.saida).toContain('SEM DADO');
    const linha = lerMatriz(raiz).linhas.find((l) => l.defeito === 'so-rpc');
    expect(linha?.invalido).toContain('AUSENCIA DE DADO');
    // E o gate suspeito NAO entra na matriz nem como verde nem como vermelho.
    expect(linha?.execucoes.some((e) => e.gate === 'g:rpc-sob-defeito')).toBe(false);
  });
});

describe('motor — WRITE-GUARD: gate que escreve na arvore versionada aborta a rodada', () => {
  it('no BASELINE: aborta nomeando o gate e o arquivo, restaura, e NAO grava matriz', () => {
    const raiz = montarFixture([...ENXUTO, 'g:escritor'], DEFS_ENXUTO);
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
    const raiz = montarFixture([...ENXUTO, 'g:escritor-sob-defeito'], DEFS_ENXUTO);
    const r = medir(raiz, ['--defeitos', 'descuidado', '--sem-poda']);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('o defeito descuidado');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
    expect(readFileSync(join(raiz, EDGE), 'utf8')).toBe('linha 1\noriginal\nlinha 3\n');
  }, 120_000);

  // `sonda:fingerprint` volta ao conjunto nas duas receitas abaixo: e o gate que PRESCREVE o
  // `regenerar-fingerprints`, e dever de casa sem o gate que o prescreve e fixture sem par no repo.
  it('receita que escreve FORA das saidas declaradas aborta (o gerador "vazou")', () => {
    const defs = `# @origem: f\n# @suspeito: g:pega\n# @dever-de-casa: regenerar-fingerprints\nvaza | ${EDGE} | s/^original$/VAZA/\n`;
    const raiz = montarFixture([...ENXUTO, 'sonda:fingerprint'], defs);
    const r = medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('DEVER-DE-CASA-ESCREVEU-FORA');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
  }, 120_000);

  // O parecer do Codex: presenca textual da sabotagem nao prova persistencia — ela pode virar
  // codigo morto sem sair do arquivo. Por isso o ALVO inteiro e intocavel pela receita.
  it('receita que mexe no ALVO aborta — o defeito medido tem de ser o declarado, byte a byte', () => {
    const defs = `# @origem: f\n# @suspeito: g:pega\n# @dever-de-casa: regenerar-fingerprints\nmexe | ${EDGE} | s/^original$/MEXE-NO-ALVO/\n`;
    const raiz = montarFixture([...ENXUTO, 'sonda:fingerprint'], defs);
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

const DEFS_CANAL = `
# @origem: fixture
# @suspeito: g:pega
canal | ${EDGE} | s/^original$/SABOTADO/
`;

describe('motor — CAPTURA: o gate roda com a saida em ARQUIVO, nunca em pipe', () => {
  // O que este teste afirma — e o que ele NAO afirma. Ele prova o CANAL: o gate recebe arquivo
  // regular, nao FIFO. Ele NAO prova nada sobre o `test` vermelho do baseline: a hipotese de que o
  // pipe fabricava aquele vermelho foi falsificada (a mesma invocacao com saida em arquivo tambem
  // sai 1 com `onTaskUpdate` quando a maquina satura). O canal vale pelo merito proprio — arquivo
  // nao tem teto de maxBuffer nem contrapressao de leitor lento.
  // docs/historico/exclusividade-media-outra-coisa.md
  it('o gate ve fd 1 e fd 2 como arquivo regular — com pipe o baseline dele fica VERMELHO', () => {
    const raiz = montarFixture(['g:barato', 'g:pega', 'g:canal'], DEFS_CANAL);
    const r = medir(raiz, ['--defeitos', 'canal']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toMatch(/verde\s+g:canal/);
    expect(r.saida, 'nenhuma das duas pontas da captura pode ser pipe').not.toContain('FIFO');
  }, 120_000);
});

describe('[fora-da-rodada] motor — o `exclusividade` vermelho SO por GATE_NOVO desta rodada sai da rodada, e so ele', () => {
  const BASE = ['g:barato', 'g:pega', 'exclusividade'];
  const DEFS = `
# @origem: fixture
# @suspeito: g:pega
pega | ${EDGE} | s/^original$/SABOTADO/

# O perl nao casa: linha INVALIDA, nenhum gate executa nela.
nao-casa | ${EDGE} | s/^inexistente$/SABOTADO/
`;
  let base = '';
  let celulaDaBase: ExecucaoGate | null = null;

  // O nascimento, como no repo real: sem matriz o `exclusividade` reprova por MATRIZ_AUSENTE, entao
  // o motor mede primeiro sem ele e ele entra DISPENSADO (a historia que `matriz.def` conta). A
  // segunda rodada, ja com ele verde, deixa na linha `pega` a celula dele — a que a fusao herda.
  beforeAll(() => {
    base = montarFixture(['g:barato', 'g:pega'], DEFS);
    const r1 = medir(base, ['--defeitos', 'pega']);
    if (r1.rc !== 0) throw new Error(`bootstrap 1: o motor saiu ${r1.rc}\n${r1.saida.slice(-1500)}`);
    const m = lerMatriz(base);
    m.dispensados = [{ gate: 'exclusividade', desde: 'fixture', motivo: 'nasce dispensado, como no repo real' }];
    writeFileSync(join(base, MATRIZ), `${JSON.stringify(m, null, 2)}\n`);
    writeFileSync(join(base, '.github/workflows/ci.yml'), ciYml(BASE));
    sh(base, 'git', ['add', '-A']);
    commitar(base, '-m', 'bootstrap 1');
    const r2 = medir(base, ['--defeitos', 'pega']);
    if (r2.rc !== 0) throw new Error(`bootstrap 2: o motor saiu ${r2.rc}\n${r2.saida.slice(-1500)}`);
    celulaDaBase = lerMatriz(base).linhas.find((l) => l.defeito === 'pega')?.execucoes.find((e) => e.gate === 'exclusividade') ?? null;
    sh(base, 'git', ['add', '-A']);
    commitar(base, '-m', 'bootstrap 2');
  }, 180_000);

  /** Copia do fixture base; `mudar`, se houver, vira commit — o motor exige arvore limpa. */
  function clonar(mudar?: (raiz: string) => void): string {
    const raiz = mkdtempSync(join(tmpdir(), 'excl-motor-'));
    raizes.push(raiz);
    cpSync(base, raiz, { recursive: true });
    if (mudar) {
      mudar(raiz);
      sh(raiz, 'git', ['add', '-A']);
      commitar(raiz, '-m', 'cenario');
    }
    return raiz;
  }
  const comGates = (gates: string[]) => (raiz: string) => writeFileSync(join(raiz, '.github/workflows/ci.yml'), ciYml(gates));
  const linhaDe = (raiz: string, id: string) => lerMatriz(raiz).linhas.find((l) => l.defeito === id);

  /** O gate REAL, como o CI o roda — o eixo POR FORA do motor. */
  const gateReal = (raiz: string) => {
    const r = spawnSync('bun', ['run', 'exclusividade'], { cwd: raiz, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    return { rc: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  // O CONTROLE de todo vermelho abaixo: no fixture base o gate real e VERDE e o motor o mede como
  // qualquer outro. Sem este verde, um fixture em que o gate real sempre reprova aprovaria tudo.
  it('CONTROLE: exclusividade verde roda na rodada como qualquer gate — sem aviso, sem recusa, e certifica', () => {
    expect(celulaDaBase, 'o bootstrap deixou a celula do exclusividade na linha pega').not.toBeNull();
    const raiz = clonar();
    const antes = gateReal(raiz);
    expect(antes.rc, antes.saida.slice(-1500)).toBe(0);
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).not.toContain('EXCLUSAO-RECUSADA');
    const l = linhaDe(raiz, 'pega');
    expect(l?.execucoes.find((e) => e.gate === 'exclusividade')?.reprovou).toBe(false);
    expect(l?.defasados).toBeUndefined();
    expect(r.saida).toMatch(/\[SO ELE\]\s+g:pega/);
  }, 120_000);

  it('so GATE_NOVO de gate desta rodada: o exclusividade sai, a celula herdada fica DEFASADA, e o ciclo fecha', () => {
    const raiz = clonar(comGates([...BASE, 'g:novo']));
    const antes = gateReal(raiz);
    expect(antes.rc, 'o cenario e mesmo o do gate novo').toBe(1);
    expect(antes.saida).toMatch(/REPROVA\s+g:novo\s+GATE_NOVO_SEM_EXCLUSIVIDADE/);

    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).toContain('GATE-NOVO-RESOLVIDO g:novo');
    const m = lerMatriz(raiz);
    const l = m.linhas.find((x) => x.defeito === 'pega');
    // Fora da rodada = nao re-executado: a celula dele e a da base, byte a byte, e fica DEFASADA.
    expect(l?.execucoes.find((e) => e.gate === 'exclusividade')).toEqual(celulaDaBase);
    expect(l?.defasados).toEqual(['exclusividade']);
    expect(l?.execucoes.find((e) => e.gate === 'g:novo')?.reprovou).toBe(false);
    // O furo do parecer Codex: o verde ANTIGO dele fecharia a linha re-medida e certificaria.
    expect(r.saida).toMatch(/\[inconcl\]\s+g:pega/);
    expect(r.saida).not.toMatch(/\[SO ELE\]\s+g:/);
    expect(m.baseline.find((b) => b.gate === 'exclusividade')?.verde, 'o baseline grava a verdade').toBe(false);
    expect(r.status.trim()).toBe(`M ${MATRIZ}`);
    // O laco fecha POR FORA do motor: o mesmo gate, lendo a matriz que a rodada gravou, sai verde.
    const depois = gateReal(raiz);
    expect(depois.rc, depois.saida.slice(-1500)).toBe(0);

    // E a receita que o aviso prescreve devolve o certificado: re-executar SO o excluido limpa a marca.
    sh(raiz, 'git', ['add', '-A']);
    commitar(raiz, '-m', 'matriz da rodada sem o exclusividade');
    const r2 = medir(raiz, ['--defeitos', 'pega', '--gates', 'exclusividade']);
    expect(r2.rc, r2.saida.slice(-2000)).toBe(0);
    expect(r2.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(linhaDe(raiz, 'pega')?.defasados).toBeUndefined();
    expect(r2.saida).toMatch(/\[SO ELE\]\s+g:pega/);
  }, 180_000);

  it('gate novo SEM execucao valida na rodada: o aviso diz que o exclusividade segue vermelho', () => {
    const raiz = clonar(comGates([...BASE, 'g:novo']));
    const r = medir(raiz, ['--defeitos', 'nao-casa']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).toContain('GATE-NOVO-SEM-EXECUCAO g:novo');
    expect(gateReal(raiz).rc, 'e o gate real concorda').toBe(1);
  }, 120_000);

  it('outro gate vermelho junto: ABORTA — a exclusao nunca afrouxa o baseline de outro gate', () => {
    const raiz = clonar(comGates([...BASE, 'g:novo', 'g:quebrado']));
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('ABORTADO: 1 gate(s) ja vermelho(s)');
    expect(r.saida).toContain('  - g:quebrado');
    expect(r.status, 'nada gravado').toBe('');
  }, 120_000);

  it('gate novo FORA da rodada (--gates): ABORTA — a rodada nao grava a execucao que o resolveria', () => {
    const raiz = clonar(comGates([...BASE, 'g:novo']));
    const r = medir(raiz, ['--defeitos', 'pega', '--gates', 'g:barato,g:pega,exclusividade']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: GATE-NOVO-FORA-DA-RODADA g:novo');
    expect(r.saida).toContain('  - exclusividade');
    expect(r.status).toBe('');
  }, 120_000);

  it('ancora da raiz quebrada junto do gate novo: ABORTA — o vermelho nao e so dele', () => {
    const raiz = clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      rmSync(join(x, '.github/workflows/auto-merge.yml'));
    });
    expect(gateReal(raiz).saida, 'o cenario e mesmo o da ancora').toContain('ANCORA-DA-RAIZ-QUEBRADA');
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: ANCORA-QUEBRADA');
    expect(r.status).toBe('');
  }, 120_000);

  it('matriz ilegivel (MATRIZ_AUSENTE): ABORTA — REPROVA alheia a gate novo', () => {
    const raiz = clonar((x) => writeFileSync(join(x, MATRIZ), '{ nao e json\n'));
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: REPROVA-ALHEIA MATRIZ_AUSENTE');
    expect(r.status).toBe('');
  }, 120_000);

  /** Troca o `exclusividade` do fixture por um de mentira — o nome e a invocacao do CI continuam os mesmos. */
  const trocarExclusividade = (comando: string) => (raiz: string) => {
    const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.exclusividade = comando;
    writeFileSync(join(raiz, 'package.json'), JSON.stringify(pkg, null, 2));
  };

  // A fiacao do exit BRUTO no motor: sem ela o criterio "exit 1 nas duas leituras" seria decorativo —
  // nos dois gates de mentira abaixo o JSON diz exatamente o que a exclusao aceitaria.
  it('baseline que sai 2 (erro do gate) com sonda de GATE_NOVO valida: ABORTA — RC-BASELINE', () => {
    const raiz = clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      trocarExclusividade('bun scripts/g.ts excl-2-e-json')(x);
    });
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: RC-BASELINE');
    expect(r.status).toBe('');
  }, 120_000);

  it('sonda que sai 0 com JSON de GATE_NOVO: ABORTA — RC-SONDA', () => {
    const raiz = clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      trocarExclusividade('bun scripts/g.ts excl-sonda-0')(x);
    });
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: RC-SONDA');
    expect(r.status).toBe('');
  }, 120_000);

  it('sonda que TAMBEM fala no stderr: o JSON do stdout chega limpo e a exclusao vale', () => {
    const raiz = clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      trocarExclusividade('bun scripts/g.ts excl-sonda-ruidosa')(x);
    });
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    // UM fd para os dois canais misturaria o ruido no JSON e mataria a exclusao aqui.
    expect(r.saida).not.toContain('SONDA-ILEGIVEL');
    expect(r.saida).not.toContain('EXCLUSAO-RECUSADA');
  }, 120_000);

  it('sonda que ESCREVE na arvore aborta pelo write-guard — a sonda e execucao como qualquer outra', () => {
    const raiz = clonar(trocarExclusividade('bun scripts/g.ts sonda-escreve'));
    const r = medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('a sonda --json do baseline');
    expect(r.status, 'arvore restaurada').toBe('');
    expect(readFileSync(join(raiz, 'escrito.txt'), 'utf8')).toBe('original\n');
  }, 120_000);

  it('--dry nao executa nada — nem baseline, nem sonda', () => {
    const raiz = clonar(comGates([...BASE, 'g:novo']));
    const r = medir(raiz, ['--dry']);
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).toContain('--dry: nada foi executado.');
    expect(r.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).not.toContain('EXCLUSAO-RECUSADA');
    expect(r.status).toBe('');
  }, 60_000);

  // Parecer Codex: com `--ignorar-baseline` outro vermelho seguiria adiante, e "so ele saiu da
  // conta" deixaria de ser verdade. Os dois mecanismos nao se combinam: o manual fica como sempre foi.
  it('--ignorar-baseline NAO combina com a exclusao: o motor avisa e mede como sempre mediu', () => {
    const raiz = clonar(comGates([...BASE, 'g:novo']));
    const r = medir(raiz, ['--defeitos', 'pega', '--ignorar-baseline', '--sem-poda']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('IGNORAR-BASELINE-SEM-EXCLUSAO');
    expect(r.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    const l = linhaDe(raiz, 'pega');
    expect(l?.execucoes.find((e) => e.gate === 'exclusividade')?.reprovou, 'medido vermelho, como antes').toBe(true);
    expect(l?.defasados).toBeUndefined();
  }, 120_000);

  it('defeito cujo @suspeito e o excluido: podado, o suspeito NAO roda fora da poda', () => {
    const raiz = clonar((x) => {
      comGates([...BASE, 'g:novo', 'g:pega2'])(x);
      writeFileSync(join(x, 'scripts/exclusividade.d/x.def'), `${DEFS}\n# @suspeito: exclusividade\npoda-suspeito | ${EDGE} | s/^original$/SABOTADO/\n`);
    });
    const r = medir(raiz, ['--defeitos', 'poda-suspeito']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).toContain('o suspeito de poda-suspeito (exclusividade) saiu da rodada');
    const l = linhaDe(raiz, 'poda-suspeito');
    expect(l?.parouCedo, 'dois vermelhos: a linha foi podada').toBe(true);
    expect(l?.execucoes.map((e) => e.gate)).not.toContain('exclusividade');
  }, 120_000);
});
