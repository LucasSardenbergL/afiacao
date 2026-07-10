#!/usr/bin/env bun
/**
 * authz-gate-check.ts — gate de CI anti-regressão de autorização em RPCs SECURITY DEFINER.
 * ============================================================================================
 *
 * Chip task_fc0cc5bd (follow-up do PR #1264). Mata o padrão de bug recorrente: uma migration
 * faz CREATE OR REPLACE de uma função SECDEF sensível e OMITE o gate → vazamento silencioso.
 *
 * Duas partes (spec: docs/superpowers/specs/2026-07-09-authz-gate-regression-check-design.md):
 *  - Parte A (regressão): TODA recriação (em qualquer migration) de uma função do manifest deve
 *    conter o gate esperado em forma de bloqueio. Ausência → erro nomeando a migration.
 *  - Parte B (cobertura): no estado final (last-writer-wins), TODA SECDEF que toca custo/preço/
 *    estoque deve estar classificada — `gated` (com requiredGate) ou `acknowledged` (baseline
 *    não customer-facing). Uma SECDEF sensível nova não classificada → erro (força classificação).
 *
 * Uso:  bun run authz:check           # roda no CI (ci.yml, job validate) e local
 *       bun scripts/authz-gate-check.ts --json
 * Fonte: supabase/migrations/*.sql (o CI prova o REPO, não o PROD — audit de PROD é complemento).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFunctionDefs, checkGate, touchesSensitive, type FunctionDef } from './lib/authz-contract';
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

/**
 * núcleo testável: lista de migrations → achados (erros bloqueiam, avisos não).
 * Trabalha no ESTADO FINAL (last-writer-wins por nome): migrations são imutáveis e "a última a
 * recriar vence", então o que importa é a ÚLTIMA definição de cada função — não o histórico
 * (uma versão antiga sem o gate atual é passado, não risco presente). Um PR novo que recria
 * uma função do manifest sem o gate vira a última def → a Parte A falha.
 */
export function auditAuthz(migrations: Migration[]): Finding[] {
  const findings: Finding[] = [];
  const finalByName = new Map<string, { def: FunctionDef; file: string }>();

  const ordered = [...migrations].sort((a, b) => a.file.localeCompare(b.file));
  for (const mig of ordered) {
    let defs: FunctionDef[] = [];
    try {
      defs = extractFunctionDefs(mig.sql);
    } catch {
      continue; // parser degrada em silêncio, nunca fabrica achado
    }
    for (const def of defs) {
      finalByName.set(manifestKey(def.schema, def.name), { def, file: mig.file }); // last-writer
    }
  }

  // Parte A — regressão: a ÚLTIMA definição de cada função do manifest tem o gate esperado.
  for (const [mkey, entry] of Object.entries(AUTHZ_MANIFEST)) {
    const rec = finalByName.get(mkey);
    if (!rec) {
      findings.push({ level: 'warn', file: '—', fn: mkey, msg: `no manifest mas sem definição nas migrations (só no schema-snapshot?) — gate não verificável estaticamente.` });
      continue;
    }
    const res = checkGate(rec.def.body, entry.requiredGate);
    if (!res.ok) {
      findings.push({
        level: 'error',
        file: rec.file,
        fn: mkey,
        msg: `última def de ${mkey} está SEM o gate esperado (falta: ${res.missing.join(' ou ') || '—'}). Motivo: ${entry.motivo}`,
      });
    } else if (res.weak.length > 0) {
      findings.push({
        level: 'warn',
        file: rec.file,
        fn: mkey,
        msg: `${mkey}: gate presente mas fora da forma "IF NOT <gate>(…) THEN RAISE" (${res.weak.join(', ')}) — confira que barra, não só decora.`,
      });
    }
  }

  // Parte B — cobertura: toda SECDEF sensível no estado final deve estar classificada.
  for (const [mkey, { def, file }] of finalByName) {
    if (!def.securityDefiner) continue;
    const sensitive = touchesSensitive(def.body);
    if (sensitive.length === 0) continue;
    if (AUTHZ_MANIFEST[mkey] || ACKNOWLEDGED_SENSITIVE.has(mkey)) continue;
    findings.push({
      level: 'error',
      file,
      fn: mkey,
      msg: `SECURITY DEFINER toca dado sensível (${sensitive.join(', ')}) e NÃO está classificada. Adicione ${mkey} a AUTHZ_MANIFEST (com gate) ou a ACKNOWLEDGED_SENSITIVE (com justificativa) em scripts/authz-manifest.ts. Última def: ${file}`,
    });
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
