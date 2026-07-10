#!/usr/bin/env bun
/**
 * authz-gate-check.ts — gate de CI anti-regressão de autorização em RPCs SECURITY DEFINER.
 * ============================================================================================
 *
 * Chip task_fc0cc5bd (follow-up do PR #1264). Mata o padrão de bug recorrente: uma migration
 * faz CREATE OR REPLACE de uma função SECDEF sensível e OMITE o gate → vazamento silencioso.
 *
 * Duas partes (spec: docs/superpowers/specs/2026-07-09-authz-gate-regression-check-design.md):
 *  - Parte A (regressão): a ÚLTIMA definição (last-writer) de cada função do manifest deve conter
 *    o gate esperado EM FORMA DE BLOQUEIO. Ausência, gate decorativo (presente sem bloquear), ou
 *    recriação que o parser não conseguiu extrair (fail-closed) → erro nomeando a migration.
 *  - Parte B (cobertura): no estado final (last-writer por ASSINATURA, p/ não perder overloads),
 *    TODA SECDEF que toca custo/preço/estoque deve estar classificada — `gated` ou `acknowledged`.
 *    Uma SECDEF sensível nova não classificada → erro.
 *
 * Uso:  bun run authz:check           # roda no CI (ci.yml, job validate) e local
 *       bun scripts/authz-gate-check.ts --json
 * Fonte: supabase/migrations/*.sql (o CI prova o REPO, não o PROD — audit de PROD é complemento).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFunctions, checkGate, touchesSensitive, type FunctionDef } from './lib/authz-contract';
import { AUTHZ_MANIFEST, ACKNOWLEDGED_SENSITIVE, manifestKey } from './authz-manifest';

export interface Finding {
  level: 'error' | 'warn';
  file: string;
  fn: string;
  msg: string;
}
export interface Migration {
  file: string;
  sql: string;
}

/** núcleo testável: lista de migrations → achados (erros bloqueiam, avisos não). */
export function auditAuthz(migrations: Migration[]): Finding[] {
  const findings: Finding[] = [];
  const finalByName = new Map<string, { def: FunctionDef; file: string }>(); // p/ Parte A (gate por nome)
  const finalBySig = new Map<string, { def: FunctionDef; file: string }>(); // p/ Parte B (overloads distintos)
  const lastMention = new Map<string, { file: string; parsed: boolean }>(); // fail-closed: última menção deu p/ parsear?

  const ordered = [...migrations].sort((a, b) => a.file.localeCompare(b.file));
  for (const mig of ordered) {
    let extracted;
    try {
      extracted = extractFunctions(mig.sql);
    } catch {
      continue;
    }
    for (const def of extracted.defs) {
      const nkey = manifestKey(def.schema, def.name);
      finalByName.set(nkey, { def, file: mig.file });
      finalBySig.set(def.key, { def, file: mig.file });
      lastMention.set(nkey, { file: mig.file, parsed: true });
    }
    for (const u of extracted.unparsed) {
      lastMention.set(manifestKey(u.schema, u.name), { file: mig.file, parsed: false });
    }
  }

  // Parte A — regressão: última def de cada função do manifest tem o gate em forma de bloqueio.
  for (const [mkey, entry] of Object.entries(AUTHZ_MANIFEST)) {
    const mention = lastMention.get(mkey);
    if (!mention) {
      findings.push({ level: 'warn', file: '—', fn: mkey, msg: `no manifest mas sem definição nas migrations (só no schema-snapshot?) — gate não verificável estaticamente.` });
      continue;
    }
    if (!mention.parsed) {
      findings.push({
        level: 'error',
        file: mention.file,
        fn: mkey,
        msg: `recria ${mkey} numa forma que o parser NÃO extraiu (quoted identifier? corpo não dollar/single-quoted?) — o gate não pode ser garantido (fail-closed). Ajuste a migration ou o parser (scripts/lib/authz-contract.ts).`,
      });
      continue;
    }
    const rec = finalByName.get(mkey)!;
    const res = checkGate(rec.def.body, entry.requiredGate);
    if (!res.ok) {
      const why =
        res.missing.length > 0
          ? `falta a chamada de ${res.missing.join(' ou ')}`
          : `${res.weak.join(', ')} aparece mas fora da forma de bloqueio "IF NOT <gate>(…) THEN RAISE EXCEPTION" (gate decorativo não protege)`;
      findings.push({ level: 'error', file: rec.file, fn: mkey, msg: `última def de ${mkey} SEM gate válido: ${why}. Motivo: ${entry.motivo}` });
    }
  }

  // Parte B — cobertura: toda SECDEF sensível no estado final (por assinatura) está classificada.
  for (const [, { def, file }] of finalBySig) {
    if (!def.securityDefiner) continue;
    const sensitive = touchesSensitive(def.body);
    if (sensitive.length === 0) continue;
    const mkey = manifestKey(def.schema, def.name);
    if (AUTHZ_MANIFEST[mkey] || ACKNOWLEDGED_SENSITIVE.has(mkey)) continue;
    findings.push({
      level: 'error',
      file,
      fn: def.signature ? `${mkey}(${def.signature})` : mkey,
      msg: `SECURITY DEFINER toca dado sensível (${sensitive.join(', ')}) e NÃO está classificada. Adicione ${mkey} a AUTHZ_MANIFEST (com gate) ou a ACKNOWLEDGED_SENSITIVE (com justificativa) em scripts/authz-manifest.ts. Última def: ${file}`,
    });
  }

  // fail-closed genérico: CREATE FUNCTION não extraído, fora do manifest → aviso (pode ser SECDEF sensível).
  for (const [mkey, mention] of lastMention) {
    if (mention.parsed || AUTHZ_MANIFEST[mkey]) continue;
    findings.push({ level: 'warn', file: mention.file, fn: mkey, msg: `CREATE FUNCTION ${mkey} não extraído pelo parser — se for SECDEF que toca custo/preço/estoque, classifique manualmente em scripts/authz-manifest.ts.` });
  }

  return findings;
}

function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

function main(): void {
  const json = process.argv.includes('--json');
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const findings = auditAuthz(loadMigrations(dir));
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (json) {
    console.log(JSON.stringify({ ok: errors.length === 0, findings }, null, 2));
    process.exit(errors.length === 0 ? 0 : 1);
  }

  for (const w of warns) console.log(`⚠️  ${w.file} — ${w.msg}`);
  for (const e of errors) console.error(`❌ ${e.file} — ${e.msg}`);
  if (errors.length > 0) {
    console.error(`\nauthz:check — ${errors.length} erro(s) de contrato de autorização. Ver scripts/authz-manifest.ts.`);
    process.exit(1);
  }
  console.log(`✅ authz:check — contrato de gate ok${warns.length ? ` (${warns.length} aviso(s))` : ''}. Parte A (regressão) + Parte B (cobertura) verdes.`);
}

if (import.meta.main) main();
