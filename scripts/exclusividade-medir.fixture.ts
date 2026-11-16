/**
 * Fixture COMPARTILHADO da suite do motor (`scripts/exclusividade-medir*.test.ts`).
 *
 * A suite era UM arquivo de ~55 s no CI, o mais lento do vitest e o piso do fast-path dos PRs so de
 * docs. Foi dividida em 4 arquivos (o vitest paraleliza entre arquivos, nunca dentro de um); os
 * helpers vieram para ca sem mudar uma linha de logica. O `afterAll` de limpeza registra no arquivo
 * que importa. docs/historico/ci-escopo-so-docs.md
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll } from 'vitest';

import { BINARIOS_DAS_DEPS, lerMatriz, type Matriz } from './lib/exclusividade';

export const MOTOR = resolve('scripts/exclusividade-medir.ts');
const GATE_REAL = resolve('scripts/exclusividade-gate.ts');
export const EDGE = 'supabase/functions/fx/index.ts';
export const VERSAO = 'supabase/functions/fx/versao.ts';
export const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';
export const MATRIZ = 'scripts/exclusividade-matriz.json';

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
      // O gerador que TRAVA numa arvore surda ao TERM: a receita sob o teto de grupo do motor (guarda 15).
      if (edge.includes('SURDO-GERADOR')) spawnSync('sh', ['scripts/arvore.sh', 'surdo'], { stdio: 'ignore' });
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
  // O que o exclusividade REAL diz de uma matriz de outro schema. No fixture real essa matriz nem
  // chega ao baseline (guarda 14); so assim o ramo REPROVA-ALHEIA segue exercitado ponta a ponta.
  case 'excl-reprova-alheia': {
    const json = JSON.stringify({ ancoraQuebrada: [], vereditos: [{ severidade: 'REPROVA', gate: '(todos)', codigo: 'MATRIZ_SCHEMA_INCOMPATIVEL', motivo: 'fixture' }] });
    if (process.argv.includes('--json')) writeFileSync(1, json + '\\n');
    process.exit(1);
  }
}
process.exit(9);
`;

/**
 * Gates de PROCESSO para o teto do motor — a forma do `sonda:cron-prova` real: `bun run` -> script -> filhos.
 * Cada papel registra `<papel> <pid>` de todo processo que cria em `$PIDS_TETO` (FORA da arvore, como o
 * contador do RPC), para o teste conferir que nenhum sobreviveu ao motor. Sem corte, duram 30s — muito
 * mais que teto + carencia dos cenarios, e menos que o timeout do vitest.
 *
 *  - obediente: TRATA o TERM (registra que limpou e sai 0). O neto, sem trap, morre no TERM do grupo.
 *    O handler começa ignorando novos TERM: o do GRUPO e o que o `bun run` repassa chegam juntos, e o
 *    dash (o `sh` do runner Linux) reentra no trap — 5 de 100 rodadas gravavam "limpou" 2× (0 no bash).
 *  - surdo: `trap '' TERM`. O SIG_IGN e herdado no exec, entao o neto tambem e surdo: so o KILL encerra.
 *  - neto-surdo: o filho morre no TERM, mas deixa um neto surdo para tras — o orfao que o
 *    `killSignal: 'SIGKILL'` cria, porque mata o `bun run` antes de ele repassar qualquer sinal.
 *  - surdo-sob-defeito: o surdo so com a edge SABOTADA — baseline verde, a rodada trava NO defeito.
 */
const ARVORE_SH = `#!/bin/sh
papel=$1
case "$papel" in
  obediente) trap 'trap "" TERM; echo "limpou $$" >> "$PIDS_TETO"; exit 0' TERM ;;
  surdo) trap '' TERM ;;
  surdo-sob-defeito) grep -q SABOTADO ${EDGE} || exit 0; trap '' TERM ;;
esac
echo "$papel $$" >> "$PIDS_TETO"
if [ "$papel" = neto-surdo ]; then sh -c "trap '' TERM; exec sleep 30" & else sleep 30 & fi
echo "$papel $!" >> "$PIDS_TETO"
wait
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
  'g:obediente': 'sh scripts/arvore.sh obediente',
  'g:surdo': 'sh scripts/arvore.sh surdo',
  'g:neto-surdo': 'sh scripts/arvore.sh neto-surdo',
  'g:surdo-sob-defeito': 'sh scripts/arvore.sh surdo-sob-defeito',
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
  'g:obediente': 'run: bun run g:obediente',
  'g:surdo': 'run: bun run g:surdo',
  'g:neto-surdo': 'run: bun run g:neto-surdo',
  'g:surdo-sob-defeito': 'run: bun run g:surdo-sob-defeito',
  exclusividade: 'run: bun run exclusividade',
};

/**
 * O universo da RODADA LIMPA, o bloco que prova a poda por CUSTO: o `g:lento` (900ms) e o suspeito
 * caro que essa ordem poe atras dos gates de bytes — e so por isso a poda para antes dele e o
 * "suspeito podado RODA fora da poda" tem o que provar. Cenario que nao mede poda usa o ENXUTO.
 */
export const PADRAO = ['g:barato', 'g:lento', 'g:args', 'g:env', 'sonda:bump', 'sonda:fingerprint'];

export const DEFS_PADRAO = `
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
export const ENXUTO = ['g:barato', 'g:pega'];
export const DEFS_ENXUTO = `
# @origem: fixture
# @suspeito: g:pega
descuidado | ${EDGE} | s/^original$/SABOTADO/
`;

export const raizes: string[] = [];
afterAll(() => {
  for (const r of raizes) rmSync(r, { recursive: true, force: true });
});

interface Saida {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `spawn` ASSINCRONO — nunca `spawnSync` para subprocesso que pode demorar.
 *
 * O `spawnSync` segura o event loop do worker do vitest pelo tempo INTEIRO do filho, e acima de 60s
 * o RPC `onTaskUpdate` estoura: o timer vence durante o bloqueio e, quando o loop volta, a fase de
 * timers roda ANTES da de I/O — o timeout dispara com a resposta ja na fila. Medido isolado
 * (2026-09-25): `spawnSync('sleep', ['65'])` da rc=1 com 2/2 passando; `await setTimeout(65s)`,
 * rc=0. Uma rodada do motor sob carga passa de 60s, e ERA ESTE ARQUIVO que fazia o `test` sair
 * vermelho sem teste falhando — o vermelho que travava a propria medicao do motor (guarda 12).
 * `spawnSync`s seguidos tambem nao devolvem o loop entre si: montar o fixture e medir viravam UM bloco.
 */
export function rodar(cmd: string, argv: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<Saida> {
  return new Promise((ok, falha) => {
    const filho = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    filho.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    filho.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    filho.on('error', falha);
    filho.on('close', (status) => ok({ status, stdout, stderr }));
  });
}

export async function sh(cwd: string, cmd: string, argv: string[]): Promise<string> {
  const r = await rodar(cmd, argv, { cwd });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * Commit do fixture sem herdar hook, assinatura ou identidade da maquina de quem roda — nem a
 * manutencao automatica. Todo `git commit` dispara `git maintenance run --auto --detach`, que
 * SOBREVIVE ao commit: cria e apaga `.git/objects/maintenance.lock` (sempre, antes de avaliar
 * qualquer condicao) e pode empacotar objetos loose. O `cpSync` do `clonar` lista esse arquivo e
 * nao o acha mais: ENOENT em `.git/objects` (CI, PR #2536), ou o worker ABORTA quando um
 * `objects/xx` some no meio da copia.
 */
export const commitar = (raiz: string, ...argv: string[]) =>
  sh(raiz, 'git', ['-c', 'user.name=f', '-c', 'user.email=f@f', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', 'commit', '-q', ...argv]);

export const ciYml = (gates: string[]) =>
  `jobs:\n  j:\n    steps:\n${gates.map((g) => `      - name: ${g}\n        ${PASSO[g]}`).join('\n')}\n  validate:\n    needs: [j]\n`;

/** Um binario de mentira: `#!/bin/sh` + o corpo, com o modo pedido (o `+x` e parte do que se mede). */
export function binFalso(dir: string, nome: string, corpo: string, modo = 0o755): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, nome), `#!/bin/sh\n${corpo}\n`);
  chmodSync(join(dir, nome), modo);
}

/**
 * As deps do fixture: os binarios que a guarda 13 do motor sonda, respondendo `--version` como os
 * reais. Sem eles o motor aborta por DEPS-NAO-INSTALADAS em qualquer cenario — como a ancora da raiz.
 */
export function instalarDeps(raiz: string): void {
  for (const b of BINARIOS_DAS_DEPS) binFalso(join(raiz, 'node_modules/.bin'), b, `echo "${b}/1.0.0 fixture"`);
}

export async function montarFixture(gates: string[], defs: string, deps: (raiz: string) => void = instalarDeps): Promise<string> {
  const raiz = mkdtempSync(join(tmpdir(), 'excl-motor-'));
  raizes.push(raiz);
  const arquivos: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: SCRIPTS }, null, 2),
    'scripts/g.ts': GATES_TS,
    'scripts/arvore.sh': ARVORE_SH,
    '.github/workflows/ci.yml': ciYml(gates),
    // A 2a ponta da ancora da raiz: sem ela o `exclusividade` REAL reprova por ANCORA em qualquer cenario.
    '.github/workflows/auto-merge.yml': '# mergeia quando o required check `validate` passa\n',
    // O `node_modules` fica fora da arvore versionada, como no repo real — senao a guarda 1a (arvore suja) o acusaria.
    '.gitignore': 'node_modules/\n',
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
  deps(raiz);
  await sh(raiz, 'git', ['init', '-q']);
  // O mapa nasce do proprio gerador do fixture, como o real nasce do `--write`.
  await sh(raiz, 'bun', ['run', 'sonda:fingerprint', '--', '--write']);
  await sh(raiz, 'git', ['add', '-A']);
  await commitar(raiz, '-m', 'fixture');
  return raiz;
}

export async function medir(raiz: string, argv: string[] = [], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, EXCL_TIMEOUT_MS: '60000', ...extraEnv };
  const r = await rodar('bun', [MOTOR, ...argv], { cwd: raiz, env });
  const status = (await rodar('git', ['status', '--porcelain'], { cwd: raiz })).stdout;
  return { rc: r.status, saida: `${r.stdout}${r.stderr}`, status };
}

/**
 * O que a rodada gravou, lido pela MESMA porta do gate: o motor nao pode gravar uma matriz que o
 * `exclusividade` recusaria no CI — escritor e leitor discordando calados sobre o mesmo JSON.
 */
export const matrizGravada = (raiz: string): Matriz => {
  const l = lerMatriz(readFileSync(join(raiz, MATRIZ), 'utf8'));
  if (!l.ok) throw new Error(`a rodada gravou uma matriz que o gate RECUSA: ${l.codigo} ${l.motivo}`);
  return l.matriz;
};


/**
 * Os helpers do bloco do TETO (antes locais ao `describe`), agora dividido em dois arquivos. Chame
 * DENTRO do `describe`: o `afterAll` que mata orfaos registra nele, como antes.
 */
export function contextoTeto() {
  const TETO = 4000;
  const CARENCIA = 3000;
  /** Folga para a carga da maquina — e ainda bem abaixo dos 30s que o gate dura sem corte. */
  const FOLGA = 3000;
  const arquivos: string[] = [];
  afterAll(() => {
    // Higiene sob falsificacao: um motor sabotado deixa orfaos, e eles nao vazam para o resto da suite.
    for (const p of arquivos.flatMap(lerPids)) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        /* ja morreu */
      }
    }
  });
  const arquivoDePids = () => {
    const dir = mkdtempSync(join(tmpdir(), 'excl-teto-'));
    raizes.push(dir);
    arquivos.push(join(dir, 'pids'));
    return join(dir, 'pids');
  };
  /** `<papel> <pid>` de cada processo que o gate criou — e `limpou <pid>` de quem tratou o TERM. */
  function lerPids(arq: string): { papel: string; pid: number }[] {
    if (!existsSync(arq)) return [];
    return readFileSync(arq, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ papel: l.split(' ')[0], pid: Number(l.split(' ')[1]) }));
  }
  const vivo = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Os vivos depois de ate 2s: o KILL ja foi entregue, mas o reaper do orfao pode levar um instante. */
  async function sobreviventes(pids: number[]): Promise<number[]> {
    for (let i = 0; i < 20 && pids.some(vivo); i++) await new Promise((ok) => setTimeout(ok, 100));
    return pids.filter(vivo);
  }
  const msDe = (saida: string, gate: string): number | null => {
    const m = saida.match(new RegExp(`VERMELHO\\s+${gate}\\s+(\\d+)ms \\(ESTOUROU`));
    return m ? Number(m[1]) : null;
  };
  const ambiente = (pids: string) => ({ EXCL_TIMEOUT_MS: String(TETO), EXCL_CARENCIA_MS: String(CARENCIA), PIDS_TETO: pids });
  const defsDe = (suspeito: string) => `# @origem: f\n# @suspeito: ${suspeito}\nd | ${EDGE} | s/^original$/SABOTADO/\n`;
  return { TETO, CARENCIA, FOLGA, arquivoDePids, lerPids, sobreviventes, msDe, ambiente, defsDe };
}
