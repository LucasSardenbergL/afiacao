#!/usr/bin/env bun
/**
 * Triagem read-only de candidatos `.tsx` à promoção para `tsconfig.strict.json`.
 *
 * Por quê: a migração strict é leaf-first (ver docs/strict-migration-lanes.md). Promover
 * um arquivo puxa seus imports transitivos pro programa strict — então só é seguro promover
 * um `.tsx` quando TODOS os seus imports locais (src) JÁ estão no strict. Este script encoda
 * o filtro correto, evitando os 2 bugs que já custaram um lote refeito:
 *   (1) casar imports com aspas DUPLAS e SIMPLES (`from "..."` e `from '...'`);
 *   (2) excluir `lazy(() => import())` / `import()` dinâmico — contam como import pro tsc
 *       e puxam o subgrafo (um "leaf" que lazy-carrega outro arquivo NÃO é leaf).
 *
 * Saída: classifica cada `.tsx` ainda fora do strict em READY / NEAR / RISKY / LAZY.
 *   READY  = leaf de verdade (todos os imports locais já no strict, sem lazy/dynamic, sem
 *            supabase/rpc/posthog/useUrlState no corpo). Candidato a promoção mecânica
 *            (tsconfig-only) — sujeito a validação por `typecheck:strict` (ver doc).
 *   NEAR   = 1-2 blockers locais (imports ainda fora do strict). Batchável junto se os
 *            blockers também forem promovidos no mesmo lote.
 *   RISKY  = toca supabase/.rpc(/posthog/useUrlState — promover exige cuidado extra.
 *   LAZY   = usa lazy()/import() dinâmico — não é leaf, exclua.
 *
 * Uso:  bun scripts/strict-tsx-triage.mjs            # resumo
 *       bun scripts/strict-tsx-triage.mjs --ready    # só os paths READY (1 por linha)
 *
 * NOTA: READY garante que as deps estão no strict, NÃO que o corpo do arquivo é strict-clean.
 * Sempre valide o lote escolhido anexando ao include e rodando `heavy bun run typecheck:strict`
 * (com CPU calma) antes de commitar. Ver docs/strict-tsx-ready-candidates.md.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, resolve, join } from 'path';

const ROOT = process.cwd();
const onlyReady = process.argv.includes('--ready');

// Conjunto já no strict (paths "src/..." do include)
const tscRaw = readFileSync(join(ROOT, 'tsconfig.strict.json'), 'utf8');
const strict = new Set([...tscRaw.matchAll(/"(src\/[^"]+)"/g)].map((m) => m[1]));

// Todos os .tsx de src (sem testes/d.ts)
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx') && !p.endsWith('.d.ts')) {
      acc.push(p.replace(ROOT + '/', ''));
    }
  }
  return acc;
}
const allTsx = walk(join(ROOT, 'src')).sort();
const notStrict = allTsx.filter((f) => !strict.has(f));

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec).replace(ROOT + '/', '');
  else return { external: true };
  const cands = [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx'), base + '.d.ts'];
  for (const c of cands) if (existsSync(join(ROOT, c))) return { path: c };
  return { path: base, missing: true };
}

const RISKY = /supabase|\.rpc\(|useUrlState|posthog/i;
const results = [];

for (const f of notStrict) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const hasLazy = /\blazy\s*\(|React\.lazy|\bimport\s*\(/.test(src);
  const imps = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const local = imps.map((s) => ({ spec: s, ...resolveImport(f, s) })).filter((r) => !r.external);
  const localSrc = local.filter((r) => r.path && r.path.startsWith('src/'));
  const blockers = localSrc.filter((r) => !strict.has(r.path) && !r.missing).map((r) => r.path);
  const missing = localSrc.filter((r) => r.missing).map((r) => r.path);
  const risky = RISKY.test(src);
  results.push({ f, loc: src.split('\n').length, hasLazy, risky, blockers, missing });
}

const ready = results.filter((r) => !r.hasLazy && !r.risky && r.blockers.length === 0 && r.missing.length === 0);
const near = results.filter((r) => !r.hasLazy && !r.risky && r.blockers.length > 0 && r.blockers.length <= 2 && r.missing.length === 0);

if (onlyReady) {
  ready.sort((a, b) => a.loc - b.loc).forEach((r) => console.log(r.f));
} else {
  console.log(`strict atual: ${strict.size} | .tsx fora do strict: ${notStrict.length}`);
  console.log(`READY=${ready.length} NEAR=${near.length} RISKY=${results.filter((r) => r.risky && !r.hasLazy).length} LAZY=${results.filter((r) => r.hasLazy).length}\n`);
  console.log('=== READY (leaf de verdade — candidato a promoção mecânica) ===');
  ready.sort((a, b) => a.loc - b.loc).forEach((r) => console.log(`  [${String(r.loc).padStart(3)}L] ${r.f}`));
  console.log('\n=== NEAR (1-2 blockers — batchável com os blockers) ===');
  near.sort((a, b) => a.blockers.length - b.blockers.length).forEach((r) => console.log(`  [${r.blockers.length}b] ${r.f}  ←  ${r.blockers.join(', ')}`));
}
