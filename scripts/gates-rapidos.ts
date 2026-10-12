#!/usr/bin/env bun
/**
 * gates-rapidos.ts — `bun run gates:rapidos`: os gates baratos do CI numa chamada só, ANTES do PR.
 * =============================================================================================
 *
 * Por quê (M-23 do plano `docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md`):
 * 36% das falhas de CI em 60 dias eram gates de 0–2 s que ninguém rodava antes do push. Cada uma
 * custava um ciclo de CI (~7,5 min) para dizer o que 7 s locais diriam. O hook
 * `.claude/hooks/pr-collision-guard.sh` chama este script no `gh pr create`.
 *
 * Os gates rodam EM PARALELO (todos leem o disco, nenhum escreve), cada um com teto de tempo. Medido
 * em 2026-10-11 numa M2 8 GB: soma sequencial ~22 s, o mais lento `canaria:bump` 6,8 s.
 *
 * Veredito, sempre com a última linha como marca ASCII fixa (o hook casa a marca, não a prosa):
 *   exit 0  `GATES_RAPIDOS_OK n=<N>`                todos deram exit 0
 *   exit 1  `GATES_RAPIDOS_REPROVOU: a, b`          ≥1 gate deu exit≠0 dentro do tempo (veredito)
 *   exit 2  `GATES_RAPIDOS_SEM_VEREDITO: a, b`      nenhum reprovou, mas ≥1 não mediu (timeout,
 *                                                   spawn falhou, script sumiu do package.json)
 * Sentinela de varredura vazia: lista vazia ou script ausente do package.json NÃO é "nada a checar",
 * é o agregador sem alvo, e sai ≠ 0. O teste (`gates-rapidos.test.ts`) prova que cada nome da lista
 * existe no package.json e que um gate sabotado vira exit 1.
 *
 * Os gates de DIFF (`sonda:bump`, `sonda:nova`, `canaria:bump`) só rodam em `pull_request` no CI;
 * aqui calculam a própria base contra a `origin/main`, que é exatamente o momento pré-PR.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Os gates do CI que custam ≤ ~7 s e não precisam de rede, deno, banco nem build. */
export const GATES_RAPIDOS: readonly string[] = [
  'sonda:fingerprint',
  'sonda:bump',
  'sonda:nova',
  'sonda:autentica',
  'canaria:bump',
  'authz:check',
  'authz:carimbo',
  'bunpin:check',
  'docs:indice',
  'docs:citacoes',
  'docs:links',
  'gates:frescura',
  'claude:size',
  'knip',
];

export type Resultado =
  | { gate: string; tipo: 'passou'; ms: number }
  | { gate: string; tipo: 'reprovou'; ms: number; exit: number; saida: string }
  | { gate: string; tipo: 'sem-veredito'; ms: number; motivo: string };

/** Decide o exit e a marca a partir dos resultados — PURO, testável sem rodar gate nenhum. */
export function consolidar(rs: Resultado[]): { exit: 0 | 1 | 2; marca: string } {
  if (rs.length === 0) return { exit: 2, marca: 'GATES_RAPIDOS_SEM_VEREDITO: (nenhum gate rodou)' };
  const reprovou = rs.filter((r) => r.tipo === 'reprovou').map((r) => r.gate);
  if (reprovou.length > 0) return { exit: 1, marca: `GATES_RAPIDOS_REPROVOU: ${reprovou.join(', ')}` };
  const semVeredito = rs.filter((r) => r.tipo === 'sem-veredito').map((r) => r.gate);
  if (semVeredito.length > 0) {
    return { exit: 2, marca: `GATES_RAPIDOS_SEM_VEREDITO: ${semVeredito.join(', ')}` };
  }
  return { exit: 0, marca: `GATES_RAPIDOS_OK n=${rs.length}` };
}

/** `knip` não é script do package.json: roda via `bunx`. O resto é `bun run <script>`. */
function comando(gate: string): string[] {
  return gate === 'knip' ? ['bunx', 'knip'] : ['bun', 'run', gate];
}

export function scriptsAusentes(gates: readonly string[], pkgJson: string): string[] {
  const scripts = (JSON.parse(pkgJson) as { scripts?: Record<string, string> }).scripts ?? {};
  return gates.filter((g) => g !== 'knip' && !(g in scripts));
}

function rodar(gate: string, raiz: string, tetoMs: number): Promise<Resultado> {
  const t0 = Date.now();
  const [bin, ...args] = comando(gate);
  return new Promise((resolve) => {
    let saida = '';
    let estourou = false;
    const p = spawn(bin, args, { cwd: raiz, env: { ...process.env, FORCE_COLOR: '0' } });
    const relogio = setTimeout(() => {
      estourou = true;
      p.kill('SIGKILL');
    }, tetoMs);
    p.stdout.on('data', (d) => (saida += d));
    p.stderr.on('data', (d) => (saida += d));
    p.on('error', (e) => {
      clearTimeout(relogio);
      resolve({ gate, tipo: 'sem-veredito', ms: Date.now() - t0, motivo: `spawn: ${e.message}` });
    });
    p.on('close', (code) => {
      clearTimeout(relogio);
      const ms = Date.now() - t0;
      if (estourou) resolve({ gate, tipo: 'sem-veredito', ms, motivo: `passou do teto de ${tetoMs} ms` });
      else if (code === 0) resolve({ gate, tipo: 'passou', ms });
      else if (code === null) resolve({ gate, tipo: 'sem-veredito', ms, motivo: 'morto por sinal' });
      else resolve({ gate, tipo: 'reprovou', ms, exit: code, saida });
    });
  });
}

async function main(): Promise<number> {
  const raiz = join(import.meta.dir, '..');
  const tetoMs = Number(process.env.GATES_RAPIDOS_TETO_MS ?? 60_000);
  const ausentes = scriptsAusentes(GATES_RAPIDOS, readFileSync(join(raiz, 'package.json'), 'utf8'));
  const rodaveis = GATES_RAPIDOS.filter((g) => !ausentes.includes(g));

  const rs: Resultado[] = [
    ...ausentes.map((g): Resultado => ({ gate: g, tipo: 'sem-veredito', ms: 0, motivo: 'script ausente do package.json' })),
    ...(await Promise.all(rodaveis.map((g) => rodar(g, raiz, tetoMs)))),
  ];

  for (const r of rs) {
    const s = (r.ms / 1000).toFixed(1).padStart(5);
    if (r.tipo === 'passou') console.log(`  ✓ ${r.gate.padEnd(18)} ${s}s`);
    else if (r.tipo === 'sem-veredito') console.log(`  ? ${r.gate.padEnd(18)} ${s}s  sem veredito: ${r.motivo}`);
    else console.log(`  ✗ ${r.gate.padEnd(18)} ${s}s  exit ${r.exit}`);
  }
  for (const r of rs) {
    if (r.tipo !== 'reprovou') continue;
    console.log(`\n── ${r.gate} (exit ${r.exit}) — últimas linhas ──`);
    console.log(r.saida.trimEnd().split('\n').slice(-15).join('\n'));
  }
  const { exit, marca } = consolidar(rs);
  console.log(`\n${marca}`);
  return exit;
}

if (import.meta.main) process.exit(await main());
