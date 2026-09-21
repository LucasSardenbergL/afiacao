#!/usr/bin/env bun
/**
 * exclusividade-medir.ts — o MOTOR. Sabota o repo real e mede quais gates ficam vermelhos.
 * =======================================================================================
 *
 * Roda FORA do CI (caro por construcao: n defeitos x m gates). Grava
 * `scripts/exclusividade-matriz.json`, que o gate barato `bun run exclusividade` le no CI —
 * o mesmo desenho do `authz:carimbo`: medicao cara na maquina que tem o que medir, veredito
 * barato onde ele precisa bloquear.
 *
 * Uso:
 *   bun run exclusividade:medir                      # corpus inteiro x gates bloqueantes
 *   bun run exclusividade:medir -- --defeitos a,b    # so estes defeitos
 *   bun run exclusividade:medir -- --gates x,y       # so estes gates
 *   bun run exclusividade:medir -- --dry             # lista o plano e o custo, nao executa nada
 *   bun run exclusividade:medir -- --sem-poda        # nao para no 2o vermelho: quer o conjunto COMPLETO
 *   EXCL_TIMEOUT_MS=2400000 bun run exclusividade:medir   # teto POR execucao (default 15 min). Numa M2
 *                                                         # carregada o `sonda:cron-prova -- --gate` leva ~19.
 *
 * Exit: 0 mediu - 1 abortou (arvore suja, baseline vermelho, corpus vazio/invalido, invocacao nao
 *       reproduzivel, suspeito desconhecido, GATE-ESCREVEU, RESTAURACAO-INCOMPLETA) - 2 erro interno.
 *
 * ## A disciplina (herdada do mutcheck.sh, onde ja foi pensada e ja achou buraco de verdade)
 *
 *  1. ARVORE LIMPA + BASELINE VERDE. Se um gate ja esta vermelho antes da sabotagem, TODO
 *     resultado depois dele e lixo: sempre-vermelha aprova tudo. E a licao de
 *     `docs/historico/falsificacao-sem-linha-de-base.md`, e ela custou um PR inteiro.
 *  2. COPIA + trap em SIGINT/SIGTERM/uncaught. O repo NUNCA fica mutado, nem em Ctrl-C.
 *  3. GUARD ANTI-NAO-APLICACAO. perl que nao casou = INVALIDO, jamais um falso "ninguem pegou" —
 *     que e a forma mais cara de errar aqui, porque fabricaria exclusividade zero.
 *  4. SUBSTITUICAO UNICA. Sabotagem que altera >1 linha e regex largo demais (no incerto):
 *     INVALIDA. Sem isso, "o gate pegou" pode ser sobre um estrago que ninguem commitaria.
 *  5. PODA POR CUSTO, NAO POR DECLARACAO. Gates rodam do mais barato ao mais caro e a linha para
 *     no 2o vermelho — a exclusividade ja esta refutada ali. A ORDEM e o PONTO DE PARADA nunca
 *     consultam `@suspeito`: deixar o autor declarar quem e "plausivel" podaria a medicao a favor
 *     de quem declara.
 *  6. PARIDADE DE INVOCACAO. Cada gate roda com o argv+env que o CI usa (`invocacaoDoCI`), nunca
 *     `bun run <nome>` cru. O cru media o modo BACKFILL do `sonda:cron-prova` (que regrava o
 *     manifesto e sujou o baseline inteiro) e um `tsc` NO-OP. Invocacao que o motor nao reproduz
 *     ABORTA antes do baseline — adivinhar seria medir outro comando com o nome do gate.
 *  7. WRITE-GUARD. Snapshot da arvore versionada (porcelain -uall + conteudo, entradas do indice,
 *     HEAD) antes e depois de CADA execucao. Gate que escreveu: o motor restaura o que sabe
 *     restaurar — nunca apaga o que o gate criou, nunca mexe no indice nem no HEAD — e ABORTA sem
 *     gravar a matriz, porque toda medicao depois dele seria de outra arvore. Invalidar so a linha
 *     pressuporia restauracao provada; a escrita inesperada e justamente a quebra dessa premissa.
 *  8. O SUSPEITO RODA MESMO PODADO. Se a poda deixou o `@suspeito` de fora, ele roda depois, sozinho.
 *     Nao favorece ninguem: isso so acontece com `parouCedo` (>=2 vermelhos), linha que ja nao
 *     certifica exclusivo; a execucao extra so da ao suspeito o `rodou/pegou` que a poda lhe negou.
 *     Sem ela, o suspeito saia "medido" sem nunca ter rodado (o caso `sonda:autentica`).
 *  9. DEVER DE CASA POR RECEITA. `@dever-de-casa` aplica, depois da sabotagem, uma receita do
 *     vocabulario FECHADO (`RECEITAS`), com efeito EXATO conferido por snapshot: so as saidas
 *     declaradas mudam, e o alvo segue byte-identico ao pos-sabotagem. Receita que nao muda nada ou
 *     falha = linha INVALIDA; receita que escreve fora das saidas = ABORTA.
 * 10. CONTROLE DE SAIDA. Depois de restaurar cada defeito, o snapshot tem de ser IGUAL ao inicial.
 *     "Restaurei" sem assercao e a mesma familia de ausente != zero.
 * 11. O `exclusividade` VERMELHO SO POR GATE NOVO SAI DA RODADA — E SO ELE. Ele le a matriz que este
 *     motor escreve: um gate novo no `ci.yml` o deixa vermelho ate a matriz ter a execucao do novo,
 *     que so esta rodada grava. A sonda (a invocacao do CI + `--json`, sob o write-guard) diz o
 *     porque; se TODA REPROVA e GATE_NOVO de gate que a rodada executa, ele nao roda em defeito
 *     nenhum, a celula antiga dele fica DEFASADA e so ele sai da conta do baseline
 *     (`exclusividadeVermelhaSoPorGateNovo`, fail-closed). Qualquer outro vermelho aborta; com
 *     `--ignorar-baseline` a exclusao nao se aplica. Ver
 *     `docs/historico/baseline-que-depende-da-propria-medicao.md`.
 *
 * ## O que o write-guard NAO ve (limite declarado)
 *
 * Arquivo IGNORADO pelo git (`node_modules/`, `dist/`, caches) fica fora do snapshot: vigia-lo
 * custaria hashear `node_modules` a cada execucao e daria falso positivo no `build`, que escreve
 * `dist/` por oficio. O CI tambem nao isola isso por gate — cada JOB tem checkout novo, mas os gates
 * de um mesmo job dividem a arvore. O residuo possivel (um gate lendo o `dist/` que outro deixou)
 * segue existindo aqui como la.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { mensagemDeErro } from '@/lib/erro-mensagem';

import {
  ARGV_REGENERAR_FINGERPRINTS,
  CORPUS_DIR,
  GATE_EXCLUSIVIDADE,
  MATRIZ_PATH,
  SCHEMA_VERSION,
  aplicarBumpVersao,
  assinaturaInvocacao,
  derivar,
  exclusividadeVermelhaSoPorGateNovo,
  fingerprintDefeito,
  fingerprintGate,
  fonteDoGate,
  fundirLinhas,
  gatesCandidatos,
  invocacaoDoCI,
  parseDefeitos,
  resumir,
  saidasDoDever,
  textoDoDever,
  type BaselineGate,
  type Defeito,
  type DeverDeCasa,
  type ExecucaoGate,
  type GateAlvo,
  type Invocacao,
  type LinhaMatriz,
  type Matriz,
} from './lib/exclusividade';

const args = process.argv.slice(2);
const flag = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const soDefeitos = flag('--defeitos')?.split(',').map((s) => s.trim());
const soGates = flag('--gates')?.split(',').map((s) => s.trim());
const dry = args.includes('--dry');
/**
 * Desliga a poda do 2o vermelho. A poda e correta para o objetivo padrao (exclusividade ja esta
 * refutada com 2 vermelhos), mas ela responde "e exclusivo?" — nao "QUEM pega?". Investigar uma
 * duplicacao especifica ("o vitest cobre o step do docs:indice?") exige o conjunto COMPLETO, e sob
 * poda o gate caro simplesmente nunca roda. Custa a lista inteira por defeito; use dirigido.
 */
const semPoda = args.includes('--sem-poda');
const TIMEOUT_MS = Number(process.env.EXCL_TIMEOUT_MS ?? 900_000);

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const fonteCI = readFileSync('.github/workflows/ci.yml', 'utf8');

/** Falha do INSTRUMENTO: aborta a rodada inteira e nunca vira resultado de gate. */
class Abortar extends Error {}

// ---------------------------------------------------------------------------------------------
// Restauracao — registrada ANTES de qualquer mutacao, para o trap valer desde o primeiro byte
// ---------------------------------------------------------------------------------------------

const backups = new Map<string, string>();
const tmp = join(tmpdir(), `exclusividade-${process.pid}`);
mkdirSync(tmp, { recursive: true });

/** O PRIMEIRO backup de um caminho e o original; nunca e sobrescrito pelo estado ja sabotado. */
function registrarBackup(alvo: string): void {
  if (backups.has(alvo)) return;
  const copia = join(tmp, alvo.replace(/\//g, '__'));
  copyFileSync(alvo, copia);
  backups.set(alvo, copia);
}

function restaurarTudo(): void {
  for (const [alvo, copia] of backups) {
    try {
      copyFileSync(copia, alvo);
    } catch {
      console.error(`FALHA AO RESTAURAR ${alvo} — recupere com: git checkout -- ${alvo}`);
    }
  }
  backups.clear();
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    restaurarTudo();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  restaurarTudo();
  console.error(e);
  process.exit(2);
});

// ---------------------------------------------------------------------------------------------
// Snapshot da arvore versionada — a evidencia POSITIVA de que ninguem escreveu
// ---------------------------------------------------------------------------------------------

interface EntradaSuja {
  xy: string;
  digest: string;
  conteudo: Buffer | null;
}
interface Snapshot {
  head: string;
  /** Hash de `git ls-files --stage`: porcelain nao distingue dois blobs staged de mesmo status. */
  indice: string;
  sujos: Map<string, EntradaSuja>;
}
interface Diferenca {
  head: boolean;
  indice: boolean;
  caminhos: string[];
}

const hash = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Leitura do git que so vale com sucesso POSITIVO: rc!=0 nunca e "arvore limpa". */
function git(argv: string[]): Buffer {
  const r = spawnSync('git', argv, { maxBuffer: 512 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Abortar(
      `MECANICA: \`git ${argv.join(' ')}\` falhou (rc=${r.status}) — sem leitura positiva do git o motor nao ` +
        `afirma nada sobre a arvore. ${String(r.stderr ?? '').slice(0, 200)}`,
    );
  }
  return r.stdout;
}

function digestDe(p: string): { digest: string; conteudo: Buffer | null } {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { digest: 'AUSENTE', conteudo: null };
  }
  if (st.isSymbolicLink()) return { digest: `L:${readlinkSync(p)}`, conteudo: null };
  if (!st.isFile()) return { digest: `T:${st.mode}`, conteudo: null };
  const c = readFileSync(p);
  return { digest: `F:${st.mode}:${hash(c)}`, conteudo: c };
}

function tirarSnapshot(): Snapshot {
  const head = git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
  const indice = hash(git(['ls-files', '--stage', '-z']));
  const campos = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).toString('utf8').split('\0');
  const sujos = new Map<string, EntradaSuja>();
  for (let i = 0; i < campos.length; i++) {
    const c = campos[i];
    if (!c) continue;
    const xy = c.slice(0, 2);
    const p = c.slice(3);
    sujos.set(p, { xy, ...digestDe(p) });
    // Rename/copy no indice: o campo seguinte e a ORIGEM, que tambem saiu do lugar.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const origem = campos[++i];
      if (origem) sujos.set(origem, { xy: `${xy}<`, ...digestDe(origem) });
    }
  }
  return { head, indice, sujos };
}

function diferenca(a: Snapshot, b: Snapshot): Diferenca {
  const caminhos: string[] = [];
  for (const p of new Set([...a.sujos.keys(), ...b.sujos.keys()])) {
    const x = a.sujos.get(p);
    const y = b.sujos.get(p);
    if (!x || !y || x.xy !== y.xy || x.digest !== y.digest) caminhos.push(p);
  }
  return { head: a.head !== b.head, indice: a.indice !== b.indice, caminhos: caminhos.sort() };
}

const vazia = (d: Diferenca): boolean => !d.head && !d.indice && d.caminhos.length === 0;

function descrever(d: Diferenca, a: Snapshot, b: Snapshot): string[] {
  return [
    ...(d.head ? [`HEAD moveu: ${a.head.slice(0, 9)} -> ${b.head.slice(0, 9)} (confira \`git reflog\`)`] : []),
    ...(d.indice ? ['o INDICE do git mudou (entradas staged) — confira `git diff --cached`'] : []),
    ...d.caminhos.map((p) => `${p}  [${a.sujos.get(p)?.xy ?? 'limpo'} -> ${b.sujos.get(p)?.xy ?? 'limpo'}]`),
  ];
}

/**
 * Devolve ao estado de `antes` o que foi escrito nos `caminhos` — so o que da para devolver sem
 * destruir: conteudo de arquivo (do snapshot, ou do blob no HEAD CAPTURADO — nunca `git checkout`,
 * que le do INDICE). Arquivo criado do zero fica; indice e HEAD nao sao tocados. Devolve o residuo
 * DESTES caminhos (+ indice/HEAD) — o resto da arvore e assunto de quem o sujou de proposito.
 */
function desfazerEscrita(antes: Snapshot, caminhos: string[]): string[] {
  for (const p of caminhos) {
    const x = antes.sujos.get(p);
    try {
      if (x?.conteudo) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, x.conteudo);
      } else if (!x && spawnSync('git', ['cat-file', '-e', `${antes.head}:${p}`]).status === 0) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, git(['cat-file', 'blob', `${antes.head}:${p}`]));
      }
    } catch {
      // aparece no residuo abaixo
    }
  }
  const depois = tirarSnapshot();
  const resto = diferenca(antes, depois);
  const tentados = new Set(caminhos);
  return descrever({ ...resto, caminhos: resto.caminhos.filter((p) => tentados.has(p)) }, antes, depois);
}

function abortarPorEscrita(marca: string, quem: string, antes: Snapshot, dif: Diferenca, depois: Snapshot): never {
  const escrito = descrever(dif, antes, depois);
  const residuo = desfazerEscrita(antes, dif.caminhos);
  throw new Abortar(
    [
      `${marca}: ${quem} alterou a arvore versionada:`,
      ...escrito.map((l) => `  - ${l}`),
      'Toda medicao depois disso seria de OUTRA arvore — a rodada foi abortada e a matriz NAO foi gravada.',
      residuo.length
        ? `Restauracao INCOMPLETA (o motor nao apaga arquivo criado nem mexe no indice/HEAD) — confira a mao:\n${residuo
            .map((l) => `  - ${l}`)
            .join('\n')}`
        : 'O conteudo alterado foi restaurado e conferido por snapshot.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------------------------
// Execucao de um gate — com a invocacao do CI, sob o write-guard
// ---------------------------------------------------------------------------------------------

interface GateMedivel extends GateAlvo {
  inv: Invocacao;
  assinatura: string;
}

interface Execucao {
  reprovou: boolean;
  ms: number;
  estourou: boolean;
  cauda: string;
  /** Exit BRUTO (`null` = sinal/erro): `reprovou` sozinho nao separa REPROVA (1) de erro do gate (2). */
  rc: number | null;
  /** stdout INTEIRO, separado do stderr: a sonda `--json` le JSON aqui, e a `cauda` mistura e corta. */
  stdout: string;
}

/**
 * A captura vai para ARQUIVO, nunca para pipe — e os dois canais em arquivos SEPARADOS.
 *
 * ATENCAO ao motivo, que ja foi entendido errado: isto NAO conserta o `test` vermelho do baseline.
 * A hipotese de que o pipe fabricava aquele vermelho foi FALSIFICADA — `bun run test` cru, com a
 * saida em ARQUIVO, tambem sai 1 com `Timeout calling "onTaskUpdate"`, 842 arquivos passando e zero
 * teste falhando. O discriminador era a CARGA da maquina (112s passa, 169-222s reprova), nao o
 * canal. Ver docs/historico/exclusividade-media-outra-coisa.md (secao do #2530).
 *
 * O que arquivo resolve, pelo merito proprio: o pipe carregava um teto de `maxBuffer` (256 MB aqui)
 * cujo estouro PERDE a execucao inteira, e faz o filho depender de leitor rapido para nao sofrer
 * contrapressao. Arquivo regular nao tem nenhum dos dois. `encoding` e `maxBuffer` saem porque sem
 * pipe nao ha buffer a limitar; argv, env e timeout de `invocacaoDoCI` seguem byte a byte, que e a
 * paridade que o motor promete.
 *
 * Os canais ficam separados de PROPOSITO: a sonda `--json` faz `JSON.parse` do stdout INTEIRO
 * (`exclusividadeVermelhaSoPorGateNovo`), e um fd compartilhado com o stderr contaminaria o JSON —
 * a exclusao morreria em SONDA-ILEGIVEL, trocando uma porta fechada por outra.
 *
 * E o temporario vive FORA da arvore: o write-guard olha `git status --untracked-files=all`, entao
 * um arquivo de captura dentro do repo abortaria a propria rodada por GATE-ESCREVEU.
 */
function rodarGate(g: GateMedivel): Execucao {
  const dir = mkdtempSync(join(tmpdir(), 'excl-captura-'));
  try {
    return capturarEmArquivo(g, dir);
  } finally {
    // Limpeza nao e veredito: se o temporario resistir, a medicao ja esta lida e vale.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* residuo em /tmp nao invalida a execucao */
    }
  }
}

function capturarEmArquivo(g: GateMedivel, dir: string): Execucao {
  const pOut = join(dir, 'stdout');
  const pErr = join(dir, 'stderr');
  const fdOut = openSync(pOut, 'w');
  const fdErr = openSync(pErr, 'w');
  try {
    const t0 = Date.now();
    const r = spawnSync(g.inv.argv[0], g.inv.argv.slice(1), {
      timeout: TIMEOUT_MS,
      stdio: ['ignore', fdOut, fdErr],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...g.inv.env },
    });
    const ms = Date.now() - t0;
    // O filho ja saiu: o que ele escreveu esta no arquivo, inclusive se foi morto pelo timeout.
    const saida = readFileSync(pOut, 'utf8');
    const erro = readFileSync(pErr, 'utf8');
    // Timeout/kill nao e "passou": e ausencia de dado. Marcamos como estourou e a linha vira invalida.
    const estourou = r.signal !== null || r.error !== undefined;
    const cauda = `${saida}${erro}`.trim().slice(-600);
    return { reprovou: r.status !== 0, ms, estourou, cauda, rc: r.status, stdout: saida };
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
  }
}

function rodarGuardado(g: GateMedivel, fase: string): Execucao {
  const antes = tirarSnapshot();
  const r = rodarGate(g);
  const depois = tirarSnapshot();
  const dif = diferenca(antes, depois);
  if (!vazia(dif)) abortarPorEscrita('GATE-ESCREVEU', `\`${g.inv.argv.join(' ')}\` (${g.nome}, durante ${fase})`, antes, dif, depois);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Sabotagem
// ---------------------------------------------------------------------------------------------

/** Aplica a expressao perl no alvo. Devolve o motivo de invalidez, ou null se aplicou limpo. */
function sabotar(d: Defeito): string | null {
  if (!existsSync(d.alvo)) return `alvo inexistente: ${d.alvo}`;

  const antes = readFileSync(d.alvo, 'utf8');
  registrarBackup(d.alvo);

  const r = spawnSync('perl', ['-i', '-pe', d.perl, d.alvo], { encoding: 'utf8' });
  if (r.status !== 0) return `perl falhou: ${(r.stderr || '').trim().slice(0, 200)}`;

  const depois = readFileSync(d.alvo, 'utf8');
  // Guard 3: nao casou = INVALIDO. Nunca um falso "ninguem pegou".
  if (antes === depois) return 'a expressao perl NAO casou nada (regex obsoleto?)';

  // Guard 4: perturbacao MINIMA. Contamos linhas que sairam + linhas que entraram (multiset), e
  // nao "linhas na mesma posicao que diferem": comparar por posicao trata a remocao de uma unica
  // linha — a sabotagem mais natural contra um indice — como se o arquivo inteiro tivesse
  // deslizado, e barraria como "regex largo" justamente o defeito que se quer medir.
  //
  //   substituir 1 linha -> 1 saiu + 1 entrou = 2      remover 1 linha -> 1 + 0 = 1
  //   acrescentar 1 linha -> 0 + 1 = 1                 regex largo de N linhas -> 2N
  //
  // O teto de 2 admite os tres casos legitimos e ainda barra o no incerto.
  const conta = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = conta(antes.split('\n'));
  const cd = conta(depois.split('\n'));
  let perturbadas = 0;
  for (const [l, n] of ca) perturbadas += Math.max(0, n - (cd.get(l) ?? 0));
  for (const [l, n] of cd) perturbadas += Math.max(0, n - (ca.get(l) ?? 0));
  if (perturbadas > 2) {
    return `a sabotagem perturbou ${perturbadas} linhas (regex largo — no incerto; o teto e 2)`;
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Dever de casa — receitas do vocabulario fechado, com efeito EXATO conferido por snapshot
// ---------------------------------------------------------------------------------------------

function executarReceita(dv: DeverDeCasa): string | null {
  if (dv.receita === 'bump-versao') {
    const [p] = saidasDoDever(dv);
    const r = aplicarBumpVersao(readFileSync(p, 'utf8'));
    if (!r.ok) return r.motivo;
    writeFileSync(p, r.novo);
    return null;
  }
  const [cmd, ...resto] = ARGV_REGENERAR_FINGERPRINTS;
  const r = spawnSync(cmd, resto, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });
  if (r.signal !== null || r.error) return `nao terminou (${r.signal ?? r.error?.message})`;
  if (r.status !== 0) return `saiu ${r.status}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-200)}`;
  return null;
}

/**
 * Aplica o dever de casa do defeito. Devolve o motivo de invalidez (ou null) e os caminhos que ele
 * alterou. Toda saida declarada entra no backup ANTES de a receita rodar — ela e restaurada junto
 * com o alvo, no fim do defeito.
 */
function fazerDeverDeCasa(d: Defeito): { invalido: string | null; tocados: string[] } {
  const inicio = tirarSnapshot();
  for (const s of new Set(d.deveres.flatMap(saidasDoDever))) {
    if (s === d.alvo) return { invalido: `a receita teria como saida o proprio alvo (${s})`, tocados: [] };
    if (!existsSync(s)) return { invalido: `a saida ${s} nao existe — receita sem onde agir`, tocados: [] };
    if (inicio.sujos.has(s)) {
      return { invalido: `a saida ${s} ja estava suja antes do dever de casa — o efeito nao se confere`, tocados: [] };
    }
    registrarBackup(s);
  }

  for (const dv of d.deveres) {
    const antes = tirarSnapshot();
    const falha = executarReceita(dv);
    const depois = tirarSnapshot();
    const dif = diferenca(antes, depois);
    const permitidas = new Set(saidasDoDever(dv));
    // O ALVO nunca e saida (conferido acima), entao qualquer byte dele que a receita mexa cai aqui.
    // E a exigencia e o alvo INTEIRO, nao a presenca da linha sabotada: a sabotagem pode virar
    // codigo morto sem sair do arquivo.
    const fora = { ...dif, caminhos: dif.caminhos.filter((p) => !permitidas.has(p)) };
    if (!vazia(fora)) {
      abortarPorEscrita('DEVER-DE-CASA-ESCREVEU-FORA', `a receita "${textoDoDever(dv)}" (saidas: ${[...permitidas].join(', ')})`, antes, fora, depois);
    }
    if (falha) return { invalido: `dever de casa "${textoDoDever(dv)}" falhou: ${falha}`, tocados: [] };
    if (dif.caminhos.length === 0) {
      return {
        invalido: `dever de casa "${textoDoDever(dv)}" NAO alterou nada — a linha mediria o autor DESCUIDADO sob o nome do diligente`,
        tocados: [],
      };
    }
  }
  return { invalido: null, tocados: diferenca(inicio, tirarSnapshot()).caminhos };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main(): number {
  // Guard 1a: arvore limpa. Sem isso, sujeira previa fica indistinguivel da sabotagem — e a
  // restauracao por copia devolveria o arquivo ao estado sujo achando que devolveu ao limpo.
  const inicial = tirarSnapshot();
  if (inicial.sujos.size && !args.includes('--permitir-sujo')) {
    console.error('ABORTADO: arvore suja. A medicao muta arquivos reais e precisa de um estado');
    console.error('limpo para restaurar. Commite ou descarte antes (ou use --permitir-sujo se');
    console.error('as mudancas nao tocam nenhum alvo do corpus).');
    console.error([...inicial.sujos.entries()].slice(0, 10).map(([p, e]) => `${e.xy} ${p}`).join('\n'));
    return 1;
  }

  if (!existsSync(CORPUS_DIR)) {
    console.error(`ABORTADO: corpus ausente em ${CORPUS_DIR}/`);
    return 1;
  }
  let defeitos: Defeito[] = [];
  try {
    for (const f of readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.def')).sort()) {
      defeitos.push(...parseDefeitos(readFileSync(join(CORPUS_DIR, f), 'utf8'), join(CORPUS_DIR, f)));
    }
  } catch (e) {
    console.error(`ABORTADO: corpus invalido — ${mensagemDeErro(e) ?? 'o parser lancou sem mensagem legivel'}`);
    return 1;
  }
  if (soDefeitos) defeitos = defeitos.filter((d) => soDefeitos.includes(d.id));
  if (defeitos.length === 0) {
    console.error('ABORTADO: nenhum defeito no corpus (ou o filtro --defeitos nao casou nada).');
    return 1;
  }

  const bloqueantes: GateAlvo[] = gatesCandidatos(fonteCI).filter((g) => g.bloqueiaPR);
  const selecionados = soGates ? bloqueantes.filter((g) => soGates.includes(g.nome)) : bloqueantes;
  if (selecionados.length === 0) {
    console.error('ABORTADO: nenhum gate candidato (o filtro --gates nao casou nada?).');
    return 1;
  }
  for (const n of soGates ?? []) {
    if (!bloqueantes.some((g) => g.nome === n)) console.error(`aviso: --gates cita "${n}", que nao e gate bloqueante do ci.yml`);
  }

  // Guard 6: paridade de invocacao, ANTES de gastar o baseline.
  const gates: GateMedivel[] = [];
  const naoReproduziveis: string[] = [];
  for (const g of selecionados) {
    const inv = invocacaoDoCI(fonteCI, g.nome);
    if (inv.ok) gates.push({ ...g, inv: { argv: inv.argv, env: inv.env }, assinatura: assinaturaInvocacao(inv) });
    else naoReproduziveis.push(inv.motivo);
  }
  if (naoReproduziveis.length) {
    console.error('ABORTADO: INVOCACAO-NAO-REPRODUZIVEL — o motor so mede o que o CI roda, exatamente:');
    for (const m of naoReproduziveis) console.error(`  - ${m}`);
    console.error('Transforme o step num comando simples, ou exclua o gate com --gates.');
    return 1;
  }

  // Guard 8a: todo @suspeito nomeia um gate bloqueante. Typo miraria o vazio e o gate de verdade
  // seguiria sem mira — melhor parar agora que depois do baseline.
  const nomesBloq = new Set(bloqueantes.map((g) => g.nome));
  const desconhecidos = defeitos.filter((d) => d.suspeito && !nomesBloq.has(d.suspeito));
  if (desconhecidos.length) {
    console.error('ABORTADO: SUSPEITO-DESCONHECIDO — @suspeito que nao e gate bloqueante do ci.yml:');
    for (const d of desconhecidos) console.error(`  - ${d.id}: ${d.suspeito} (${d.arquivo}:${d.linha})`);
    return 1;
  }

  console.log(`plano: ${defeitos.length} defeito(s) x ${gates.length} gate(s) bloqueante(s)`);
  console.log(`gates: ${gates.map((g) => g.nome).join(', ')}`);
  const naoCru = gates.filter((g) => g.inv.argv.join(' ') !== `bun run ${g.nome}` || Object.keys(g.inv.env).length);
  if (naoCru.length) {
    console.log('invocacao do CI (≠ `bun run <nome>` cru):');
    for (const g of naoCru) console.log(`  ${g.nome.padEnd(22)} ${g.assinatura}`);
  }
  for (const d of defeitos) {
    if (d.deveres.length) console.log(`dever de casa de ${d.id}: ${d.deveres.map(textoDoDever).join(' + ')}`);
    if (d.suspeito && !gates.some((g) => g.nome === d.suspeito)) {
      console.log(`aviso: o suspeito de ${d.id} (${d.suspeito}) esta FORA desta rodada — a linha NAO o medira`);
    }
  }
  if (dry) {
    console.log('--dry: nada foi executado.');
    return 0;
  }

  // Guard 1b: BASELINE. Todo gate candidato tem de estar VERDE no repo limpo. Isto tambem produz
  // a duracao que ordena a poda por custo.
  console.log('\nbaseline (repo limpo — todo gate precisa estar VERDE):');
  const baseline: BaselineGate[] = [];
  const noBaseline = new Map<string, Execucao>();
  for (const g of gates) {
    const r = rodarGuardado(g, 'o baseline');
    const verde = !r.reprovou && !r.estourou;
    baseline.push({ gate: g.nome, verde, ms: r.ms });
    noBaseline.set(g.nome, r);
    console.log(`  ${verde ? 'verde' : 'VERMELHO'}  ${g.nome.padEnd(34)} ${r.ms}ms${r.estourou ? ` (ESTOUROU ${TIMEOUT_MS}ms)` : ''}`);
    if (!verde && r.cauda) console.log(r.cauda.split('\n').map((l) => `      | ${l}`).join('\n'));
  }
  const ignorarBaseline = args.includes('--ignorar-baseline');
  let jaVermelhos = baseline.filter((b) => !b.verde);

  // Guard 1c: o `exclusividade` vermelho SO por GATE_NOVO de gate desta rodada sai da rodada — e so
  // ele (guarda 11 do cabecalho). A sonda e a invocacao do CI + `--json`, sob o write-guard; toda
  // duvida devolve o aborto de sempre (`exclusividadeVermelhaSoPorGateNovo`).
  const excl = gates.find((g) => g.nome === GATE_EXCLUSIVIDADE);
  let excluido: { nome: string; gatesNovos: string[] } | null = null;
  if (excl && jaVermelhos.some((b) => b.gate === excl.nome)) {
    if (ignorarBaseline) {
      // Parecer Codex: com a flag, outro vermelho segue adiante e "so ele saiu da conta" deixa de ser
      // verdade. O mecanismo manual fica exatamente como sempre foi.
      console.log(
        `\nIGNORAR-BASELINE-SEM-EXCLUSAO: com --ignorar-baseline o \`${excl.nome}\` vermelho NAO sai da rodada — ` +
          'os dois mecanismos nao se combinam.',
      );
    } else {
      const base = noBaseline.get(excl.nome)!;
      const argv = [...excl.inv.argv, ...(excl.inv.argv.includes('--') ? [] : ['--']), '--json'];
      const sonda = rodarGuardado({ ...excl, inv: { argv, env: excl.inv.env } }, 'a sonda --json do baseline');
      const decisao = exclusividadeVermelhaSoPorGateNovo({
        rcBaseline: base.estourou ? null : base.rc,
        rcSonda: sonda.estourou ? null : sonda.rc,
        saidaSonda: sonda.stdout,
        gatesDaRodada: gates.filter((g) => g !== excl).map((g) => g.nome),
      });
      if (decisao.excluir) {
        excluido = { nome: excl.nome, gatesNovos: decisao.gatesNovos };
        gates.splice(gates.indexOf(excl), 1);
        jaVermelhos = jaVermelhos.filter((b) => b.gate !== excl.nome);
        console.log(
          [
            `\nEXCLUSIVIDADE-FORA-DA-RODADA: \`${excl.nome}\` ficou VERMELHO no baseline so por GATE_NOVO_SEM_EXCLUSIVIDADE ` +
              `de gate(s) que esta rodada executa: ${decisao.gatesNovos.join(', ')}.`,
            '  - vermelho antes da sabotagem e vermelho em todo defeito: medi-lo seria lixo — ele NAO roda em defeito nenhum;',
            '  - SO ele saiu da conta do baseline: qualquer outro vermelho continua abortando;',
            '  - a celula ANTIGA dele numa linha re-medida fica DEFASADA: conta como execucao, nunca fecha a linha ([inconcl]);',
            `  - para certificar de novo: commite a matriz e rode \`bun run exclusividade:medir -- --gates ${excl.nome}\`.`,
          ].join('\n'),
        );
        for (const d of defeitos) {
          if (d.suspeito === excl.nome) console.log(`aviso: o suspeito de ${d.id} (${d.suspeito}) saiu da rodada — a linha NAO o medira`);
        }
      } else {
        console.error(`\nEXCLUSAO-RECUSADA: ${decisao.motivo}`);
      }
    }
  }

  if (jaVermelhos.length && !ignorarBaseline) {
    console.error(`\nABORTADO: ${jaVermelhos.length} gate(s) ja vermelho(s) no repo limpo:`);
    for (const b of jaVermelhos) console.error(`  - ${b.gate}`);
    console.error('Uma linha de base vermelha aprova QUALQUER coisa depois dela — o resultado');
    console.error('seria lixo com aparencia de medicao (docs/historico/falsificacao-sem-linha-de-base.md).');
    return 1;
  }

  // Guard 5: ordem por CUSTO medido, nunca por declaracao do autor.
  const custo = new Map(baseline.map((b) => [b.gate, b.ms]));
  const ordenados = [...gates].sort((a, b) => (custo.get(a.nome) ?? 0) - (custo.get(b.nome) ?? 0));

  const fps = new Map(
    gates.map((g) => {
      const f = fonteDoGate(g.nome, pkg.scripts);
      return [g.nome, { fingerprint: fingerprintGate(f), resolvida: f.resolvida }];
    }),
  );

  const linhas: LinhaMatriz[] = [];
  for (const d of defeitos) {
    console.log(`\ndefeito ${d.id}  (alvo ${d.alvo}${d.suspeito ? `, suspeito: ${d.suspeito}` : ''})`);
    let invalido = sabotar(d);
    let tocados: string[] = [];
    if (!invalido && d.deveres.length) {
      const dc = fazerDeverDeCasa(d);
      invalido = dc.invalido;
      tocados = dc.tocados;
      if (!invalido) console.log(`  dever de casa: ${d.deveres.map(textoDoDever).join(' + ')} — tocou ${tocados.join(', ')}`);
    }
    const execucoes: ExecucaoGate[] = [];
    const registrar = (g: GateMedivel, r: Execucao): void => {
      const fp = fps.get(g.nome)!;
      execucoes.push({
        gate: g.nome,
        reprovou: r.reprovou,
        ms: r.ms,
        fingerprint: fp.fingerprint,
        fonteResolvida: fp.resolvida,
        invocacao: g.assinatura,
      });
    };
    let parouCedo = false;

    if (invalido) {
      console.log(`  INVALIDO: ${invalido}`);
    } else {
      let vermelhos = 0;
      for (const g of ordenados) {
        const r = rodarGuardado(g, `o defeito ${d.id}`);
        if (r.estourou) {
          // Estouro NAO e "o gate passou": e ausencia de dado. A linha inteira vira invalida, em
          // vez de registrar um verde que nunca foi observado.
          console.log(`  ${g.nome}: ESTOUROU o tempo — linha invalidada`);
          invalido = `gate ${g.nome} estourou o tempo (${TIMEOUT_MS}ms)`;
          break;
        }
        registrar(g, r);
        if (r.reprovou) {
          vermelhos++;
          console.log(`  VERMELHO ${g.nome} (${r.ms}ms)`);
          // Poda: 2 vermelhos ja refutam exclusividade. Os demais ficam DESCONHECIDOS, e
          // `parouCedo` impede que a derivacao os leia como "nao reprovaram".
          if (vermelhos >= 2 && !semPoda) {
            parouCedo = true;
            console.log(`  (poda: 2 vermelhos, exclusividade ja refutada — ${ordenados.length - execucoes.length} gate(s) nao rodado(s))`);
            break;
          }
        }
      }

      // Guard 8b: o suspeito que a poda deixou de fora roda agora, sozinho. `parouCedo` fica como
      // esta — a linha ja nao certifica exclusivo de ninguem, com ou sem esta execucao.
      const suspeito = ordenados.find((g) => g.nome === d.suspeito);
      if (!invalido && suspeito && !execucoes.some((e) => e.gate === suspeito.nome)) {
        const r = rodarGuardado(suspeito, `o suspeito de ${d.id}`);
        if (r.estourou) {
          invalido = `o suspeito ${suspeito.nome} estourou o tempo (${TIMEOUT_MS}ms) na execucao fora da poda`;
          console.log(`  ${suspeito.nome}: ESTOUROU o tempo — linha invalidada`);
        } else {
          registrar(suspeito, r);
          console.log(`  ${r.reprovou ? 'VERMELHO' : 'verde'} ${suspeito.nome} (suspeito, rodado FORA da poda — ${r.ms}ms)`);
        }
      }
    }

    restaurarTudo();
    // Guard 10: controle de SAIDA. A arvore tem de voltar ao estado inicial, conferido por conteudo.
    const agora = tirarSnapshot();
    const residuo = diferenca(inicial, agora);
    if (!vazia(residuo)) {
      throw new Abortar(
        [
          `RESTAURACAO-INCOMPLETA: depois do defeito ${d.id} a arvore NAO voltou ao estado inicial:`,
          ...descrever(residuo, inicial, agora).map((l) => `  - ${l}`),
          'A matriz NAO foi gravada: o proximo defeito seria medido sobre outra arvore.',
        ].join('\n'),
      );
    }

    linhas.push({
      defeito: d.id,
      defeitoFingerprint: fingerprintDefeito(d),
      alvo: d.alvo,
      suspeito: d.suspeito,
      origem: d.origem,
      ...(d.deveres.length ? { deveres: d.deveres.map(textoDoDever), tocados } : {}),
      execucoes,
      parouCedo,
      invalido,
    });
  }

  restaurarTudo();

  const anterior = existsSync(MATRIZ_PATH) ? (JSON.parse(readFileSync(MATRIZ_PATH, 'utf8')) as Matriz) : null;
  const matriz: Matriz = {
    schemaVersion: SCHEMA_VERSION,
    medidoEm: new Date().toISOString(),
    sourceHead: inicial.head,
    dispensados: anterior?.dispensados ?? [],
    // O baseline ACUMULA por uniao, com a medicao mais recente de cada gate vencendo. Substituir
    // apagaria os gates das rodadas anteriores — e como `derivar()` usa o baseline para saber
    // quem NAO rodou num defeito, um baseline truncado devolveria `naoMedido` vazio para gates
    // que de fato nao rodaram: ausencia lida como cobertura, dentro da propria ferramenta.
    baseline: [
      ...(anterior?.baseline ?? []).filter((b) => !baseline.some((n) => n.gate === b.gate)),
      ...baseline,
    ].sort((a, b) => a.gate.localeCompare(b.gate)),
    // Medicao parcial (--gates/--defeitos) ACRESCENTA, nunca apaga o que ja foi medido antes —
    // e a fusao e por (defeito, GATE), nao por defeito. Ver `fundirLinhas`: substituir a linha
    // inteira descartava as execucoes dos gates fora do `--gates` da rodada, e ja fabricou um
    // `[SO ELE]` para um gate que a rodada anterior tinha medido como co-pegado.
    linhas: [
      ...(anterior?.linhas ?? []).filter((l) => !linhas.some((n) => n.defeito === l.defeito)),
      // Numa rodada que excluiu o `exclusividade`, a celula antiga dele fica DEFASADA (`fundirLinhas`).
      ...linhas.map((n) =>
        fundirLinhas((anterior?.linhas ?? []).find((l) => l.defeito === n.defeito), n, excluido ? [excluido.nome] : []),
      ),
    ].sort((a, b) => a.defeito.localeCompare(b.defeito)),
  };
  writeFileSync(MATRIZ_PATH, `${JSON.stringify(matriz, null, 2)}\n`);

  // O resumo usa o MESMO universo e as MESMAS assinaturas do gate do CI: certificar aqui com uma
  // regra e la com outra seria o motor e o gate discordando calados sobre o mesmo JSON.
  const assinaturas = new Map<string, string>();
  for (const g of bloqueantes) {
    const inv = invocacaoDoCI(fonteCI, g.nome);
    if (inv.ok) assinaturas.set(g.nome, assinaturaInvocacao(inv));
  }
  const universo = bloqueantes.map((g) => g.nome);
  console.log(`\n${resumir(matriz, { universo, assinaturas })}`);
  console.log(`\ngravado em ${MATRIZ_PATH}`);
  if (excluido) {
    // Repetido no FIM de proposito: a rodada real dura dezenas de minutos e o aviso do baseline sai
    // da tela. E a resposta e so a do criterio do GATE_NOVO (`rodou` na matriz fundida, com o universo
    // e as assinaturas de hoje) — afirmar o gate inteiro verde exigiria roda-lo de novo.
    const rodou = new Map(derivar(matriz, { universo, assinaturas }).map((e) => [e.gate, e.rodou.length]));
    console.log(`\nEXCLUSIVIDADE-FORA-DA-RODADA: esta rodada NAO executou \`${excluido.nome}\`.`);
    for (const g of excluido.gatesNovos) {
      const n = rodou.get(g) ?? 0;
      console.log(
        n > 0
          ? `  GATE-NOVO-RESOLVIDO ${g} — executado em ${n} linha(s) valida(s) da matriz: o GATE_NOVO dele sai com ela`
          : `  GATE-NOVO-SEM-EXECUCAO ${g} — nenhuma linha valida o executou (poda? linha invalida?): o ` +
              `\`${excluido.nome}\` seguira VERMELHO por ele. Escreva um defeito com @suspeito: ${g}`,
      );
    }
    console.log(
      `  para certificar de novo as linhas re-medidas: commite a matriz e rode ` +
        `\`bun run exclusividade:medir -- --gates ${excluido.nome}\``,
    );
  }
  const invalidas = linhas.filter((l) => l.invalido);
  if (invalidas.length) {
    console.log(`\n${invalidas.length} linha(s) INVALIDA(s) — corrija o .def, nao sao "ninguem pegou":`);
    for (const l of invalidas) console.log(`  - ${l.defeito}: ${l.invalido}`);
  }
  return 0;
}

let codigo = 2;
try {
  codigo = main();
} catch (e) {
  restaurarTudo();
  if (e instanceof Abortar) {
    console.error(`\nABORTADO — ${e.message}`);
    codigo = 1;
  } else {
    console.error(e);
    codigo = 2;
  }
} finally {
  restaurarTudo();
}
process.exit(codigo);
