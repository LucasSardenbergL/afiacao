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

/**
 * Objetos que uma migration criou mas uma migration POSTERIOR removeu/renomeou. O audit não modela
 * remoções (DROP/unschedule/rename), então sem isto apareceriam como ❌/⚠️ falso-positivo
 * ("a migration deveria criar X; X não existe" — quando X foi removido de PROPÓSITO). Excluídos do
 * inventário. Chave `<slug>::<object_name>` → motivo. Cada um confirmado via psql-ro (2026-06-27):
 * removido/substituído por outra migration, NÃO um bug. (Bug real = objeto ausente E em uso: vira ❌.)
 */
const OBSOLETE: Record<string, string> = {
  'cron_sayerlack_lote_retry::sayerlack-portal-lote-retry': 'unschedule — 20260530170000_unschedule_sayerlack_lote_retry',
  'tuning_crons_estoque_freq_e_timeouts::sync-orders-vendas-2h': 'drop — 20260527190000_drop_redundant_sync_orders_cron',
  'fin_a1_audit_lock_attach::trg_audit': 'drop — 20260523210000_drop_audit_trigger_fin_config_cashflow',
  'cron_baseline::afiacao_dispatch_notificacoes_diario': 'renomeado → afiacao_dispatch_notificacoes_30min',
  'cron_baseline::afiacao_sugestoes_diarias': 'reorganizado (sem o diário)',
  'cron_financeiro_e_fix_sayerlack::fin-omie-sync-2x-diario': 'reorganizado → crons omie-sync-*',
  'cron_sync_inventory_full::sync-inventory-full-vendas-daily': 'reorganizado → sync-inventory-vendas-30m / -servicos-1h / -colacor-vendas-1h',
  'cmc_ledger::cmc_ledger_select_staff': 'substituída → cmc_ledger_select_gestor (hardening staff→gestor)',
  'kb_specs_and_competitors::kb_product_specs_insert_staff': 'substituída → kb_product_specs_insert_master (hardening)',
  'data_health_check_sayerlack_mapeamento_gap::v_sayerlack_mapeamento_gap': 'view abandonada (zero uso no app/SQL)',
};

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

  // Objetos de TODAS as migrations (compartilhado pelas Seções 1 e 2).
  type Row = { migration: string; kind: ObjectKind; schema: string; name: string; parent: string };
  const rows: Row[] = [];
  const obsoletosExcluidos: string[] = [];
  for (const a of audits) {
    for (const o of a.objects) {
      const key = `${a.slug}::${o.name}`;
      if (OBSOLETE[key]) {
        obsoletosExcluidos.push(`${o.kind} ${o.schema}.${o.name} (${a.slug}) — ${OBSOLETE[key]}`);
        continue; // removido/renomeado por migration posterior — não conta no audit (não é bug)
      }
      rows.push({ migration: a.slug, kind: o.kind, schema: o.schema, name: o.name, parent: o.parent || '' });
    }
  }
  if (obsoletosExcluidos.length > 0) {
    lines.push(`-- ${obsoletosExcluidos.length} objeto(s) OBSOLETO(s) excluído(s) do inventário (criados por uma migration,`);
    lines.push('-- removidos/renomeados por outra — NÃO são bug; ver OBSOLETE em scripts/audit-custom-migrations.ts):');
    obsoletosExcluidos.forEach((s) => lines.push(`--   • ${s}`));
    lines.push('');
  }
  // CTE expected_objects — mesmos VALUES nas duas seções.
  const expectedObjectsCte = (trailingComma: boolean): string[] => {
    const out = ['expected_objects (migration, kind, schema_name, object_name, parent_name) AS (VALUES'];
    rows.forEach((r, i) => {
      out.push(`  (${sqlString(r.migration)}, ${sqlString(r.kind)}, ${sqlString(r.schema)}, ${sqlString(r.name)}, ${sqlString(r.parent)})${i === rows.length - 1 ? '' : ','}`);
    });
    out.push(trailingComma ? '),' : ')');
    return out;
  };

  // Section 1: status RECONCILIADO por migration (registro × existência de objetos).
  lines.push('-- =====================================================');
  lines.push('-- SECTION 1: Status reconciliado por migration');
  lines.push('-- =====================================================');
  lines.push('-- ✅ registrado            — há row em supabase_migrations.schema_migrations');
  lines.push('-- 🟡 aplicado (sem registro) — NÃO registrado, mas TODOS os objetos existem em prod.');
  lines.push('--                            Estado NORMAL deste repo: o Lovable não registra nome custom.');
  lines.push('-- ⚠️ PARCIAL (n/m)         — só ALGUNS objetos existem (apply parcial OU objeto removido/');
  lines.push('--                            renomeado por migration posterior) — investigar.');
  lines.push('-- ❌ NÃO aplicado          — não registrado E nenhum objeto existe (apply pendente OU obsoleta).');
  lines.push('-- ⚪ sem objeto rastreável  — não registrado e só tem ALTER/UPDATE/RLS (sem CREATE) — validar manual.');
  lines.push('');
  lines.push('WITH expected (version, slug, filename) AS (VALUES');
  audits.forEach((a, i) => {
    const sep = i === audits.length - 1 ? '' : ',';
    lines.push(`  ('${a.version}', ${sqlString(a.slug)}, ${sqlString(a.filename)})${sep}`);
  });
  if (rows.length > 0) {
    lines.push('),');
    expectedObjectsCte(true).forEach((l) => lines.push(l));
    lines.push('obj_status AS (');
    lines.push('  SELECT eo.migration,');
    lines.push('         count(*) AS total,');
    lines.push(`         count(*) FILTER (WHERE ${objExisteSql('eo')}) AS existem`);
    lines.push('  FROM expected_objects eo');
    lines.push('  GROUP BY eo.migration');
    lines.push(')');
    lines.push('SELECT');
    lines.push('  e.version,');
    lines.push('  e.slug,');
    lines.push('  CASE');
    lines.push("    WHEN sm.version IS NOT NULL THEN '✅ registrado'");
    lines.push("    WHEN os.migration IS NULL THEN '⚪ sem objeto rastreável'");
    lines.push("    WHEN os.existem = os.total THEN '🟡 aplicado (sem registro)'");
    lines.push("    WHEN os.existem = 0 THEN '❌ NÃO aplicado'");
    lines.push("    ELSE '⚠️ PARCIAL (' || os.existem || '/' || os.total || ')'");
    lines.push('  END AS status,');
    lines.push('  e.filename');
    lines.push('FROM expected e');
    lines.push('LEFT JOIN supabase_migrations.schema_migrations sm ON sm.version = e.version');
    lines.push('LEFT JOIN obj_status os ON os.migration = e.slug');
    lines.push('ORDER BY');
    lines.push('  CASE');
    lines.push('    WHEN sm.version IS NOT NULL THEN 5');
    lines.push('    WHEN os.migration IS NULL THEN 3');
    lines.push('    WHEN os.existem = os.total THEN 4');
    lines.push('    WHEN os.existem = 0 THEN 1');
    lines.push('    ELSE 2');
    lines.push('  END,');
    lines.push('  e.version;');
  } else {
    lines.push(')');
    lines.push('SELECT e.version, e.slug,');
    lines.push("  CASE WHEN sm.version IS NOT NULL THEN '✅ registrado' ELSE '⚪ sem objeto rastreável' END AS status,");
    lines.push('  e.filename');
    lines.push('FROM expected e');
    lines.push('LEFT JOIN supabase_migrations.schema_migrations sm ON sm.version = e.version');
    lines.push('ORDER BY e.version;');
  }
  lines.push('');
  lines.push('');

  // Section 2: object existence per migration (detalhe objeto-a-objeto)
  lines.push('-- =====================================================');
  lines.push('-- SECTION 2: Existência objeto-a-objeto (detalhe)');
  lines.push('-- =====================================================');
  lines.push('-- Detalha quais objetos de cada migration existem em prod. Use junto da Seção 1:');
  lines.push('-- migration 🟡/⚠️/❌ lá → aqui você vê QUAIS objetos faltam (status ❌).');
  lines.push('');

  if (rows.length === 0) {
    lines.push('-- Nenhum objeto extraído. (Migrations só tiveram ALTER/UPDATE, não CREATE.)');
  } else {
    const cte = expectedObjectsCte(false);
    lines.push('WITH ' + cte[0]);
    cte.slice(1).forEach((l) => lines.push(l));
    lines.push('SELECT');
    lines.push('  e.migration,');
    lines.push('  e.kind,');
    lines.push("  e.schema_name || '.' || e.object_name AS object,");
    lines.push(`  CASE WHEN ${objExisteSql('e')} THEN '✅' ELSE '❌' END AS status,`);
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

/**
 * Expressão SQL booleana: o objeto (alias `eo`/`e`) existe em prod? Reusada na Seção 1
 * (agregação por migration → 3 estados) e na Seção 2 (detalhe por objeto). Mantém os
 * checks per-kind num só lugar.
 */
function objExisteSql(a: string): string {
  return [
    '(CASE',
    `        WHEN ${a}.kind = 'table' AND EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = ${a}.schema_name AND t.table_name = ${a}.object_name) THEN true`,
    `        WHEN ${a}.kind = 'view' AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${a}.schema_name AND c.relname = ${a}.object_name AND c.relkind IN ('v','m')) THEN true`,
    `        WHEN ${a}.kind = 'index' AND EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = ${a}.schema_name AND i.indexname = ${a}.object_name) THEN true`,
    `        WHEN ${a}.kind = 'function' AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${a}.schema_name AND p.proname = ${a}.object_name) THEN true`,
    `        WHEN ${a}.kind = 'trigger' AND EXISTS (SELECT 1 FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${a}.schema_name AND tr.tgname = ${a}.object_name AND c.relname = ${a}.parent_name) THEN true`,
    `        WHEN ${a}.kind = 'cron_job' AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = ${a}.object_name) THEN true`,
    `        WHEN ${a}.kind = 'enum_value' AND EXISTS (SELECT 1 FROM pg_enum en JOIN pg_type ty ON ty.oid = en.enumtypid JOIN pg_namespace n ON n.oid = ty.typnamespace WHERE n.nspname = ${a}.schema_name AND ty.typname = ${a}.parent_name AND en.enumlabel = ${a}.object_name) THEN true`,
    `        WHEN ${a}.kind = 'rls_policy' AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = ${a}.schema_name AND p.tablename = ${a}.parent_name AND p.policyname = ${a}.object_name) THEN true`,
    '        ELSE false',
    '      END)',
  ].join('\n');
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
  lines.push('   - **Section 1** — status reconciliado por migration: ✅ registrado · 🟡 aplicado-sem-registro (OK) · ⚠️ parcial · ❌ não-aplicado · ⚪ sem objeto rastreável');
  lines.push('   - **Section 2** — existência objeto-a-objeto via `pg_catalog`/`information_schema`');
  lines.push('6. **🟡 é normal** (o Lovable não registra nome custom — a migration ESTÁ aplicada). Os acionáveis são **❌ / ⚠️**: migration commitada cujos objetos não existem em prod → investigar apply pendente ou obsolescência.');
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

  lines.push('## Próximos passos por status');
  lines.push('');
  lines.push('**❌ NÃO aplicado / ⚠️ PARCIAL** (objetos faltam em prod — o caso que importa):');
  lines.push('1. Veja na Section 2 QUAIS objetos da migration estão `❌`');
  lines.push('2. Confirme se é apply pendente (→ aplicar) OU objeto removido/renomeado por migration posterior (→ obsoleto, pode expurgar do inventário)');
  lines.push('3. Se for aplicar: abra `supabase/migrations/<arquivo>.sql` → SQL Editor → cole → Run → re-rode o audit');
  lines.push('');
  lines.push('**🟡 aplicado (sem registro)** — opcional, só pra deixar a Section 1 toda ✅. Use registro GUARDADO por existência (não cria falso-verde):');
  lines.push('```sql');
  lines.push('INSERT INTO supabase_migrations.schema_migrations (version, name, statements)');
  lines.push("SELECT '<timestamp>', '<slug>', ARRAY['-- registro retroativo (aplicado via Lovable)']");
  lines.push("WHERE EXISTS ( /* um objeto da migration, ex: SELECT 1 FROM pg_proc WHERE proname = '<func>' */ )");
  lines.push('ON CONFLICT (version) DO NOTHING;');
  lines.push('```');
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
