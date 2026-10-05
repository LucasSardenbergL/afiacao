/**
 * O event loop do worker do vitest LIVRE durante trabalho longo — infraestrutura de teste.
 *
 * POR QUÊ. O worker chama o RPC `onTaskUpdate` (birpc, timeout fixo de 60s) a cada teste e hook.
 * Se o loop dele fica PRESO — `spawnSync`/`execSync`/`execFileSync`, `Atomics.wait`, laço
 * síncrono de CPU — por mais de 60s, o timer vence durante o bloqueio e, quando o loop volta, a
 * fase de TIMERS roda antes da de I/O: o timeout dispara com a resposta já na fila, e o
 * `bun run test` sai rc=1 com ZERO teste falhando. A carga da máquina não é a causa: só empurra o
 * bloqueio além dos 60s. Discriminador (2026-09-25): `spawnSync('sleep', ['65'])` no `it` → rc=1;
 * `await setTimeout(65_000)` → rc=0. Na COLETA (topo do arquivo, corpo do `describe`) o mesmo
 * bloqueio dá rc=0 — não há chamada em voo (medido 2026-10-05) —; em `it`/`beforeAll`/`beforeEach`,
 * rc=1. Aumentar o `testTimeout` NÃO conserta: só troca o REPROVA pelo RPC.
 * docs/historico/rpc-do-vitest-e-o-loop-preso.md
 *
 * COMO. Trabalho longo cede o loop em FATIAS: subprocesso por `rodar()` (spawn assíncrono), laço de
 * CPU no teste por `emFatias()`, analisador de produção escrito como gerador (`Passos`, em
 * `@/lib/gates/passos`) por `drenarCedendo()`.
 *
 * GUARDA. `contarPulsos()`: um pulso de 10ms tem de bater DURANTE o trabalho. Com o loop preso ele
 * bate ZERO — prova o não-bloqueio por COMPORTAMENTO, sem reproduzir os 60s nem a carga.
 *
 * Os relógios e timers são os REAIS, capturados no load: um teste com fake timers não congela a
 * fatia nem o pulso.
 */
import { spawn } from 'node:child_process';
import timers from 'node:timers';
import { setImmediate as proximaVolta } from 'node:timers/promises';

import type { Passos } from '@/lib/gates/passos';

/** Trabalho síncrono máximo entre duas cessões. Sob carga a fatia estica junto com tudo, mas
 *  continua ordens de grandeza abaixo dos 60s do RPC. */
const FATIA_MS = 25;
/** Período do pulso da guarda. */
const PULSO_MS = 10;

const agora = performance.now.bind(performance);
const { setInterval: pulsarReal, clearInterval: pararPulsoReal, setTimeout: armarReal, clearTimeout: desarmarReal } = timers;

/**
 * Cede UMA volta inteira do loop — macrotarefa, que passa pelas fases de timers e de I/O. `await`
 * numa promise já resolvida NÃO serve: só cede a microtarefas, e o RPC continua na fila.
 */
export function cederAoLoop(): Promise<void> {
  return proximaVolta();
}

/** Itera `itens` cedendo o loop sempre que o trabalho entre duas cessões passa de `fatiaMs` —
 *  o corpo do `for await` conta como trabalho. */
export async function* emFatias<T>(itens: Iterable<T>, fatiaMs = FATIA_MS): AsyncGenerator<T, void, void> {
  let marco = agora();
  for (const item of itens) {
    yield item;
    if (agora() - marco >= fatiaMs) {
      await cederAoLoop();
      marco = agora();
    }
  }
}

/** O motorista do teste para um analisador `Passos`: o MESMO resultado do `drenar` da CLI,
 *  cedendo o loop a cada `fatiaMs` de trabalho. */
export async function drenarCedendo<R>(passos: Passos<R>, fatiaMs = FATIA_MS): Promise<R> {
  let marco = agora();
  for (;;) {
    const r = passos.next();
    if (r.done) return r.value;
    if (agora() - marco >= fatiaMs) {
      await cederAoLoop();
      marco = agora();
    }
  }
}

export interface Pulsos<T> {
  resultado: T;
  /** Quantas vezes o pulso de `PULSO_MS` bateu durante o trabalho. Loop preso o tempo todo → 0. */
  batidas: number;
  /** O maior trecho sem bater (inclui o começo e o fim): o bloqueio mais longo que o worker sofreu. */
  maiorIntervaloMs: number;
  duracaoMs: number;
}

/** Roda `trabalho` com o pulso batendo e devolve o resultado junto com a contagem. */
export async function contarPulsos<T>(trabalho: () => T | Promise<T>): Promise<Pulsos<T>> {
  const inicio = agora();
  let ultimo = inicio;
  let batidas = 0;
  let maiorIntervaloMs = 0;
  const pulso = pulsarReal(() => {
    const t = agora();
    batidas++;
    maiorIntervaloMs = Math.max(maiorIntervaloMs, t - ultimo);
    ultimo = t;
  }, PULSO_MS);
  try {
    const resultado = await trabalho();
    const fim = agora();
    maiorIntervaloMs = Math.max(maiorIntervaloMs, fim - ultimo);
    return { resultado, batidas, maiorIntervaloMs, duracaoMs: fim - inicio };
  } finally {
    pararPulsoReal(pulso);
  }
}

/** A mensagem de falha da guarda — o número que diz quanto tempo o worker ficou preso. */
export function descreverPulsos(p: Pulsos<unknown>): string {
  return (
    `o pulso de ${PULSO_MS}ms bateu ${p.batidas}× em ${Math.round(p.duracaoMs)}ms, e o maior trecho sem ` +
    `bater foi ${Math.round(p.maiorIntervaloMs)}ms: o trabalho PRENDE o event loop do worker — sob carga ` +
    `ele passa dos 60s e o RPC do vitest estoura (rc=1 sem teste falhando). Ceda o loop: ` +
    `src/test/loop-livre.ts`
  );
}

interface Saida {
  status: number | null;
  sinal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface OpcoesRodar {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** O stdin do filho (o `input` do `execFileSync`). Sem ele, o filho lê EOF. */
  entrada?: string;
  /** Mata o filho com SIGKILL depois disto (o `timeout` do `spawnSync`). */
  timeoutMs?: number;
}

/**
 * `spawn` ASSÍNCRONO — nunca `spawnSync`/`execFileSync` para subprocesso dentro de teste: o
 * síncrono segura o loop do worker pelo tempo INTEIRO do filho, e vários seguidos sem `await` entre
 * eles viram um bloco só. Mesma forma do `rodar()` de `scripts/exclusividade-medir.test.ts` (#2561).
 */
export function rodar(cmd: string, argv: readonly string[], opts: OpcoesRodar = {}): Promise<Saida> {
  return new Promise((ok, falha) => {
    const filho = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    filho.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    filho.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const prazo = opts.timeoutMs === undefined ? undefined : armarReal(() => filho.kill('SIGKILL'), opts.timeoutMs);
    filho.on('error', (e) => {
      if (prazo) desarmarReal(prazo);
      falha(e);
    });
    filho.on('close', (status, sinal) => {
      if (prazo) desarmarReal(prazo);
      ok({ status, sinal, stdout, stderr });
    });
    // EPIPE do filho que sai sem ler o stdin não é falha do teste — a saída dele é que conta.
    filho.stdin.on('error', () => {});
    filho.stdin.end(opts.entrada ?? '');
  });
}

/** `rodar()` que falha como o `execFileSync`: exit ≠ 0 (ou sinal) LANÇA, com o stderr na mensagem. */
export async function rodarOk(cmd: string, argv: readonly string[], opts: OpcoesRodar = {}): Promise<string> {
  const r = await rodar(cmd, argv, opts);
  if (r.status !== 0) {
    const como = r.sinal ? `sinal ${r.sinal}` : `status ${r.status}`;
    throw new Error(`${cmd} ${argv.join(' ')} → ${como}: ${r.stderr.trim()}`);
  }
  return r.stdout;
}
