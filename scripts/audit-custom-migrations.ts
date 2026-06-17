#!/usr/bin/env bun
/**
 * Audit de custom migrations
 * ===========================
 *
 * Per CLAUDE.md §5: Lovable Cloud NÃO aplica automaticamente migrations com
 * nome custom (não-UUID). Ficam no repo mas não tocam o banco. Este script:
 *
 *  1. Lista todas as migrations em supabase/migrations/
 *  2. Separa UUID-format (auto-aplicadas) de custom (precisam validação)
 *  3. Parseia cada custom migration extraindo objetos criados
 *     (tables, indexes, functions, triggers, cron jobs, enum values)
 *  4. Emite dois artefatos:
 *      - scripts/audit-custom-migrations.sql  → cola no Supabase SQL Editor
 *      - docs/migrations-audit.md             → inventário + instruções
 *
 * Rodar: `bun scripts/audit-custom-migrations.ts`
 *
 * Re-rodar sempre que migrations custom forem adicionadas — é idempotente.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractObjects, type ExtractedObject, type ObjectKind } from './lib/migration-objects';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const SQL_OUT = join(REPO_ROOT, 'scripts', 'audit-custom-migrations.sql');
const MD_OUT = join(REPO_ROOT, 'docs', 'migrations-audit.md');

const UUID_PATTERN = /_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.sql$/;
const TIMESTAMP_PATTERN = /^(\d{14})_(.+)\.sql$/;

interface MigrationAudit {
  filename: string;
  version: string;
  slug: string;
  objects: ExtractedObject[];
  rawSize: number;
}

function isCustom(filename: string): boolean {
  return !UUID_PATTERN.test(filename);
}

function loadMigrations(): MigrationAudit[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && isCustom(f)).sort();
  return files.map((filename) => {
    const content = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const m = filename.match(TIMESTAMP_PATTERN);
    return {
      filename,
      version: m?.[1] ?? filename,
      slug: m?.[2] ?? filename,
      objects: extractObjects(content),
      rawSize: content.length,
    };
  });
}

function emitSql(audits: MigrationAudit[]): string {
  const lines: string[] = [];

  lines.push('-- ========================================================================');
  lines.push('-- AUDIT — Custom Migrations');
  lines.push('-- ========================================================================');
  lines.push('--');
  lines.push('-- Gerado por: scripts/audit-custom-migrations.ts');
  lines.push(`-- Total de custom migrations: ${audits.length}`);
  lines.push('--');
  lines.push('-- Como usar:');
  lines.push('--   1. Abra o Supabase SQL Editor (via Lovable Cloud → Backend → SQL Editor)');
  lines.push('--   2. Cole TODO este arquivo numa query');
  lines.push('--   3. Run');
  lines.push('--   4. Olhe as duas tabelas de resultado: (A) timestamps aplicados, (B) objetos existentes');
  lines.push('--');
  lines.push('-- Read-only — não altera nada no banco.');
  lines.push('-- ========================================================================');
  lines.push('');

  // Section 1: timestamp existence in supabase_migrations.schema_migrations
  lines.push('-- =====================================================');
  lines.push('-- SECTION 1: Timestamps aplicados (canonical check)');
  lines.push('-- =====================================================');
  lines.push('-- Source of truth do Supabase. Se a row existe aqui, a migration rodou.');
  lines.push('');
  lines.push('WITH expected (version, slug, filename) AS (VALUES');
  audits.forEach((a, i) => {
    const sep = i === audits.length - 1 ? '' : ',';
    lines.push(`  ('${a.version}', ${sqlString(a.slug)}, ${sqlString(a.filename)})${sep}`);
  });
  lines.push(')');
  lines.push('SELECT');
  lines.push('  e.version,');
  lines.push('  e.slug,');
  lines.push('  CASE WHEN sm.version IS NOT NULL THEN \'✅ applied\' ELSE \'❌ MISSING — apply manually\' END AS status,');
  lines.push('  e.filename');
  lines.push('FROM expected e');
  lines.push('LEFT JOIN supabase_migrations.schema_migrations sm ON sm.version = e.version');
  lines.push('ORDER BY e.version;');
  lines.push('');
  lines.push('');

  // Section 2: object existence per migration
  lines.push('-- =====================================================');
  lines.push('-- SECTION 2: Object existence (cross-check)');
  lines.push('-- =====================================================');
  lines.push('-- Caso schema_migrations diga ✅ mas o objeto não exista (rollback manual,');
  lines.push('-- partial apply), esta query captura. Para cada objeto esperado, checa pg_catalog.');
  lines.push('');

  // Coletar TODOS os objetos de TODAS as migrations num único VALUES
  type Row = { migration: string; kind: ObjectKind; schema: string; name: string; parent: string };
  const rows: Row[] = [];
  for (const a of audits) {
    for (const o of a.objects) {
      rows.push({
        migration: a.slug,
        kind: o.kind,
        schema: o.schema,
        name: o.name,
        parent: o.parent || '',
      });
    }
  }

  if (rows.length === 0) {
    lines.push('-- Nenhum objeto extraído. (Migrations só tiveram ALTER/UPDATE, não CREATE.)');
  } else {
    lines.push('WITH expected_objects (migration, kind, schema_name, object_name, parent_name) AS (VALUES');
    rows.forEach((r, i) => {
      const sep = i === rows.length - 1 ? '' : ',';
      lines.push(
        `  (${sqlString(r.migration)}, ${sqlString(r.kind)}, ${sqlString(r.schema)}, ${sqlString(r.name)}, ${sqlString(r.parent)})${sep}`,
      );
    });
    lines.push(')');
    lines.push('SELECT');
    lines.push('  e.migration,');
    lines.push('  e.kind,');
    lines.push('  e.schema_name || \'.\' || e.object_name AS object,');
    lines.push('  CASE');

    // Per-kind existence check via pg_catalog / information_schema
    lines.push("    WHEN e.kind = 'table' AND EXISTS (");
    lines.push('      SELECT 1 FROM information_schema.tables t');
    lines.push('      WHERE t.table_schema = e.schema_name AND t.table_name = e.object_name');
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'view' AND EXISTS (");
    lines.push('      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace');
    lines.push("      WHERE n.nspname = e.schema_name AND c.relname = e.object_name AND c.relkind IN ('v', 'm')");
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'index' AND EXISTS (");
    lines.push('      SELECT 1 FROM pg_indexes i');
    lines.push('      WHERE i.schemaname = e.schema_name AND i.indexname = e.object_name');
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'function' AND EXISTS (");
    lines.push('      SELECT 1 FROM pg_proc p');
    lines.push('      JOIN pg_namespace n ON n.oid = p.pronamespace');
    lines.push('      WHERE n.nspname = e.schema_name AND p.proname = e.object_name');
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'trigger' AND EXISTS (");
    lines.push('      SELECT 1 FROM pg_trigger tr');
    lines.push('      JOIN pg_class c ON c.oid = tr.tgrelid');
    lines.push('      JOIN pg_namespace n ON n.oid = c.relnamespace');
    lines.push('      WHERE n.nspname = e.schema_name AND tr.tgname = e.object_name AND c.relname = e.parent_name');
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'cron_job' AND EXISTS (");
    lines.push("      SELECT 1 FROM cron.job WHERE jobname = e.object_name");
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'enum_value' AND EXISTS (");
    lines.push('      SELECT 1 FROM pg_enum en');
    lines.push('      JOIN pg_type ty ON ty.oid = en.enumtypid');
    lines.push('      JOIN pg_namespace n ON n.oid = ty.typnamespace');
    lines.push('      WHERE n.nspname = e.schema_name AND ty.typname = e.parent_name AND en.enumlabel = e.object_name');
    lines.push("    ) THEN '✅'");
    lines.push("    WHEN e.kind = 'rls_policy' AND EXISTS (");
    lines.push('      SELECT 1 FROM pg_policies p');
    lines.push('      WHERE p.schemaname = e.schema_name AND p.tablename = e.parent_name AND p.policyname = e.object_name');
    lines.push("    ) THEN '✅'");
    lines.push("    ELSE '❌'");
    lines.push('  END AS status,');
    lines.push("  NULLIF(e.parent_name, '') AS parent");
    lines.push('FROM expected_objects e');
    lines.push("ORDER BY status DESC, e.migration, e.kind, e.object_name;");
  }
  lines.push('');
  lines.push('-- ========================================================================');
  lines.push('-- FIM');
  lines.push('-- ========================================================================');
  lines.push('');

  return lines.join('\n');
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function emitMarkdown(audits: MigrationAudit[]): string {
  const lines: string[] = [];
  const total = audits.length;
  const totalObjects = audits.reduce((sum, a) => sum + a.objects.length, 0);
  const byKind = audits
    .flatMap((a) => a.objects.map((o) => o.kind))
    .reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});

  lines.push('# Migrations Audit — Custom (não-UUID)');
  lines.push('');
  lines.push(`> Gerado por \`scripts/audit-custom-migrations.ts\`. Re-rodar quando custom migrations forem adicionadas: \`bun scripts/audit-custom-migrations.ts\`.`);
  lines.push('');
  lines.push('## Contexto');
  lines.push('');
  lines.push('Per CLAUDE.md §5, **Lovable Cloud NÃO aplica automaticamente** migrations com nome custom (não-UUID) em `supabase/migrations/`. UUID-format (ex: `_868822bb-e38c-4fcf-8879-c64e48bd7630.sql`) são geradas pelo builder visual do Lovable e auto-rodam. Custom (ex: `_user_departments.sql`) ficam no repo mas precisam apply manual via Supabase SQL Editor.');
  lines.push('');
  lines.push('Este audit valida **quais custom migrations estão de fato aplicadas no banco**.');
  lines.push('');
  lines.push('## Como rodar');
  lines.push('');
  lines.push('1. Abra **Supabase Dashboard** (via Lovable Cloud → Backend → Open Supabase, ou direto via `https://supabase.com/dashboard/project/fzvklzpomgnyikkfkzai`)');
  lines.push('2. **SQL Editor** → **New query**');
  lines.push('3. Cole TODO o conteúdo de `scripts/audit-custom-migrations.sql`');
  lines.push('4. **Run** (read-only, não altera nada)');
  lines.push('5. Você verá DUAS tabelas:');
  lines.push('   - **Section 1** — timestamps em `supabase_migrations.schema_migrations` (source of truth do Supabase)');
  lines.push('   - **Section 2** — existência objeto-a-objeto via `pg_catalog`/`information_schema`');
  lines.push('6. Filtre linhas com `❌` → essas são as migrations que precisam apply manual');
  lines.push('');
  lines.push('## Resumo');
  lines.push('');
  lines.push(`- **${total}** custom migrations totais`);
  lines.push(`- **${totalObjects}** objetos esperados (criados por estas migrations)`);
  lines.push('- Quebra por tipo:');
  for (const [k, c] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  - \`${k}\`: ${c}`);
  }
  lines.push('');
  lines.push('## Inventário por migration');
  lines.push('');
  lines.push('Lista canônica do que cada migration *deveria* criar (extraído via regex de `CREATE TABLE`/`CREATE INDEX`/etc — não é parser SQL completo). Use junto com Section 2 do SQL pra cruzar com a realidade.');
  lines.push('');

  for (const a of audits) {
    lines.push(`### \`${a.filename}\``);
    lines.push('');
    if (a.objects.length === 0) {
      lines.push('> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.');
      lines.push('');
      continue;
    }
    lines.push('| Tipo | Objeto | Parent |');
    lines.push('| --- | --- | --- |');
    for (const o of a.objects) {
      lines.push(`| \`${o.kind}\` | \`${o.schema}.${o.name}\` | ${o.parent ? '`' + o.parent + '`' : '—'} |`);
    }
    lines.push('');
  }

  lines.push('## Próximos passos quando algo der `❌`');
  lines.push('');
  lines.push('1. Abra a migration correspondente em `supabase/migrations/<arquivo>.sql`');
  lines.push('2. Copie o SQL inteiro');
  lines.push('3. Supabase SQL Editor → cole → Run');
  lines.push('4. Re-rode `scripts/audit-custom-migrations.sql` pra confirmar que virou `✅`');
  lines.push('5. (Opcional) `INSERT INTO supabase_migrations.schema_migrations (version, statements) VALUES (\'<timestamp>\', ARRAY[\'<sql>\']);` pra registrar como aplicada (evita re-apply futura)');
  lines.push('');

  return lines.join('\n');
}

function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations dir não encontrado: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const audits = loadMigrations();
  console.log(`Lidas ${audits.length} custom migrations.`);

  for (const dir of [dirname(SQL_OUT), dirname(MD_OUT)]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const sql = emitSql(audits);
  writeFileSync(SQL_OUT, sql);
  console.log(`✓ Escrito ${SQL_OUT} (${sql.length} bytes)`);

  const md = emitMarkdown(audits);
  writeFileSync(MD_OUT, md);
  console.log(`✓ Escrito ${MD_OUT} (${md.length} bytes)`);

  const totalObjects = audits.reduce((sum, a) => sum + a.objects.length, 0);
  console.log(`\nResumo: ${audits.length} migrations, ${totalObjects} objetos esperados.`);
  console.log(`Próximo passo: abra ${basename(SQL_OUT)} no Supabase SQL Editor e rode.`);
}

main();
