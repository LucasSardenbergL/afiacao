#!/usr/bin/env bun
/**
 * wt-preflight-migration.ts — detecta colisão de OBJETO entre uma migration nova e
 * migrations concorrentes (outras worktrees / origin/main).
 * ============================================================================
 *
 * Por quê: migrations são aplicadas À MÃO no SQL Editor do Lovable (não por ordem de
 * timestamp). Quando 2 migrations recriam o MESMO objeto (CREATE OR REPLACE FUNCTION/VIEW),
 * "a última a rodar vence" e sobrescreve a outra SILENCIOSAMENTE (database.md §2). Este
 * comando mostra as definições concorrentes ANTES do paste — o momento de máximo valor.
 *
 * Uso:
 *   bun run wt:preflight supabase/migrations/NNN_x.sql        # legível
 *   bun run wt:preflight supabase/migrations/NNN_x.sql --full # + origin/main
 *   bun scripts/wt-preflight-migration.ts <arq> --json        # estruturado (p/ o hook)
 *   bun scripts/wt-preflight-migration.ts <nome> --stdin      # conteúdo via stdin (hook: o
 *                                                             # arquivo ainda não existe no Write)
 *
 * Severidade: function/view/trigger/rls_policy = 🔴 (recriação sobrescreve);
 *             table/index/enum/cron = 🟡 (IF NOT EXISTS / aditivo); nenhuma = 🟢.
 * Fail-open: qualquer erro de I/O/git → green silencioso (nunca trava trabalho).
 *
 * Injeção p/ teste: WT_PREFLIGHT_SCAN_DIRS=dir1:dir2 substitui o `git worktree list`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractObjects, objectKey, type ObjectKind } from './lib/migration-objects';

type Severity = 'red' | 'yellow' | 'green';
const RED_KINDS = new Set<ObjectKind>(['function', 'view', 'trigger', 'rls_policy']);

interface Hit {
  file: string;
  /** quantas worktrees têm esse arquivo (1 = trabalho em voo numa sessão) */
  worktrees: number;
  /** já na HEAD (histórico compartilhado) — evolução serial, não concorrência */
  committed: boolean;
}
interface Collision {
  key: string;
  kind: ObjectKind;
  name: string;
  severity: Severity;
  hits: Hit[];
}
interface Result {
  verdict: Severity;
  collisions: Collision[];
  scanned: number;
}
interface ConcurrentObj {
  key: string;
  file: string;
  source: string;
  timestamp: string;
}

function timestampOf(name: string): string {
  const m = basename(name).match(/^(\d{14})_/);
  return m ? m[1] : '';
}

/** rótulo legível da origem: o segmento antes de `supabase/`, senão o basename do dir */
function sourceLabel(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  const si = parts.lastIndexOf('supabase');
  if (si > 0) return parts[si - 1];
  return parts[parts.length - 1] || dir;
}

/** basenames de migrations na HEAD: histórico compartilhado (não concorrência em voo) */
function committedBasenames(): Set<string> {
  const env = process.env.WT_PREFLIGHT_COMMITTED;
  if (env !== undefined) return new Set(env.split(':').filter(Boolean));
  if (process.env.WT_PREFLIGHT_SCAN_DIRS !== undefined) return new Set(); // modo teste: tudo "em voo"
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'supabase/migrations'], { encoding: 'utf8', timeout: 5000 });
    return new Set(
      out
        .split('\n')
        .filter((f) => f.endsWith('.sql'))
        .map((f) => basename(f)),
    );
  } catch {
    return new Set();
  }
}

function listSqlInDir(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** dirs de migrations a comparar: env de teste, ou um por worktree do git */
function scanSources(): Array<{ dir: string; source: string }> {
  const env = process.env.WT_PREFLIGHT_SCAN_DIRS;
  if (env !== undefined) {
    return env
      .split(':')
      .filter(Boolean)
      .map((d) => ({ dir: d, source: sourceLabel(d) }));
  }
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
    const dirs: Array<{ dir: string; source: string }> = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        const wt = line.slice('worktree '.length).trim();
        dirs.push({ dir: join(wt, 'supabase', 'migrations'), source: `worktree:${basename(wt)}` });
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

/** objetos das migrations em origin/main (só com --full) — pega o que já mergeou */
function objectsFromOriginMain(self: string): ConcurrentObj[] {
  try {
    try {
      execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], { timeout: 8000, stdio: 'ignore' });
    } catch {
      /* offline → usa o ref local que houver */
    }
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations'], {
      encoding: 'utf8',
      timeout: 5000,
    })
      .split('\n')
      .filter((f) => f.endsWith('.sql'));
    const acc: ConcurrentObj[] = [];
    for (const f of files) {
      if (basename(f) === self) continue;
      let sql: string;
      try {
        sql = execFileSync('git', ['show', `origin/main:${f}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      } catch {
        continue;
      }
      for (const o of extractObjects(sql)) acc.push({ key: objectKey(o), file: basename(f), source: 'origin/main', timestamp: timestampOf(f) });
    }
    return acc;
  } catch {
    return [];
  }
}

function collectConcurrent(selfPath: string, full: boolean): ConcurrentObj[] {
  const self = basename(selfPath);
  const acc: ConcurrentObj[] = [];
  for (const { dir, source } of scanSources()) {
    for (const file of listSqlInDir(dir)) {
      if (basename(file) === self) continue; // não colide consigo mesmo
      let sql: string;
      try {
        sql = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const ts = timestampOf(file);
      for (const o of extractObjects(sql)) acc.push({ key: objectKey(o), file: basename(file), source, timestamp: ts });
    }
  }
  if (full) acc.push(...objectsFromOriginMain(self));
  return acc;
}

/** núcleo testável: alvo (path + sql) vs concorrentes → veredito */
export function detect(selfPath: string, sql: string, full = false): Result {
  const targetObjs = extractObjects(sql);
  const concurrent = collectConcurrent(selfPath, full);
  const committed = committedBasenames();

  // chave -> arquivo -> worktrees que têm esse arquivo (dedup por arquivo: a colisão é com a
  // MIGRATION, não com cada cópia dela espalhada pelas N worktrees)
  const byKey = new Map<string, Map<string, Set<string>>>();
  for (const c of concurrent) {
    let fm = byKey.get(c.key);
    if (!fm) {
      fm = new Map();
      byKey.set(c.key, fm);
    }
    let ss = fm.get(c.file);
    if (!ss) {
      ss = new Set();
      fm.set(c.file, ss);
    }
    ss.add(c.source);
  }

  const collisions: Collision[] = [];
  for (const o of targetObjs) {
    const k = objectKey(o);
    const fm = byKey.get(k);
    if (!fm || fm.size === 0) continue;
    const hits: Hit[] = [...fm.entries()].map(([file, sources]) => ({ file, worktrees: sources.size, committed: committed.has(file) }));
    // 🔴 só quando há colisão EM VOO (não-commitada): aí é concorrência real entre sessões.
    // Colisão só com migration já commitada = evolução serial do mesmo objeto → 🟡 informativo.
    const inFlight = hits.some((h) => !h.committed);
    collisions.push({ key: k, kind: o.kind, name: `${o.schema}.${o.name}`, severity: RED_KINDS.has(o.kind) && inFlight ? 'red' : 'yellow', hits });
  }

  // timestamp colidido com objetos distintos → 🟡 informativo (inócuo, mas vale ordenar)
  const selfTs = timestampOf(selfPath);
  const tsClash = selfTs !== '' && concurrent.some((c) => c.timestamp === selfTs);

  let verdict: Severity = 'green';
  if (collisions.some((c) => c.severity === 'red')) verdict = 'red';
  else if (collisions.length > 0 || tsClash) verdict = 'yellow';

  return { verdict, collisions, scanned: concurrent.length };
}

function printHuman(self: string, res: Result): void {
  const name = basename(self);
  if (res.verdict === 'green') {
    console.log(`🟢 wt:preflight — ${name}: sem colisão de objeto (${res.scanned} objetos concorrentes vistos).`);
    return;
  }
  console.log(`${res.verdict === 'red' ? '🔴' : '🟡'} wt:preflight — ${name}: ${res.verdict.toUpperCase()}`);
  for (const c of res.collisions) {
    console.log(`  ${c.severity === 'red' ? '🔴' : '🟡'} ${c.kind} ${c.name}`);
    for (const h of c.hits) {
      const origem = h.committed ? 'já no histórico (commitada)' : `EM VOO — ${h.worktrees} worktree(s) sem commitar`;
      console.log(`       ↳ ${h.file} — ${origem}`);
    }
  }
  if (res.verdict === 'red') {
    console.log('\n  Ação: outra worktree recria o mesmo objeto SEM ter commitado — concorrência real.');
    console.log('  Coordene: a SUA rode por ÚLTIMO no SQL Editor, ou consolide. "Última a rodar vence" — docs/agent/database.md §2.');
  } else {
    console.log('\n  Inócuo: objeto aditivo, ou já no histórico (evolução serial). Só confira a ordem de aplicação.');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  try {
    const full = args.includes('--full');
    const useStdin = args.includes('--stdin');
    const pathArg = args.find((a) => !a.startsWith('--'));
    if (!pathArg) {
      if (json) console.log(JSON.stringify({ verdict: 'green', collisions: [], scanned: 0 }));
      else console.error('uso: wt:preflight <migration.sql> [--full] [--json] [--stdin]');
      process.exit(0);
    }
    const sql = useStdin ? readFileSync(0, 'utf8') : readFileSync(pathArg, 'utf8');
    const res = detect(pathArg, sql, full);
    if (json) console.log(JSON.stringify(res));
    else printHuman(pathArg, res);
    process.exit(res.verdict === 'red' ? 1 : 0);
  } catch (e) {
    // fail-open: nunca travar por erro do próprio detector
    if (json) console.log(JSON.stringify({ verdict: 'green', collisions: [], scanned: 0, error: String(e) }));
    else console.error(`[wt:preflight] indisponível (${e}); seguindo sem checagem.`);
    process.exit(0);
  }
}

if (import.meta.main) main();
