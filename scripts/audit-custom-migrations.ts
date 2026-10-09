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
import { extractObjects, funcoesRemovidas, type ExtractedObject, type ObjectKind } from './lib/migration-objects';

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
  // Faxina de RPCs órfãs (2026-07-18) — orfandade provada via psql-ro + grep no repo antes do DROP.
  'outliers_leadtime_stack_efetivo::estimar_impacto_exclusao_outlier': 'drop — 20260718093248_drop_estimar_impacto_exclusao_outlier_orfa',
  'omie_identidade_por_conta::omie_cliente_upsert_mapping': 'drop — 20260718091409_drop_omie_cliente_upsert_mapping_orfa (PR #1409)',
  // Faxina de falso-vermelhos (2026-10-08) — 20 ❌ do audit, TODOS remoção/renomeação/troca de schema
  // feita de propósito por migration POSTERIOR (o extrator casa nome literal e não modela DROP/RENAME/
  // SET SCHEMA). Cada substituto CONFERIDO EXISTINDO em prod via psql-ro no mesmo dia (pg_policies,
  // pg_indexes, pg_trigger, pg_proc, pg_constraint) — ausência + substituto vivo = não é bug.
  'atp_reserva_estoque_fase1::estoque_reservas_service_all': 'drop — 20260806225052_atp_reserva_estoque_fase1_1_hardening (decorativa: service_role tem BYPASSRLS) → estoque_reservas_service_select',
  'carteira_membership_ledger_fatia0::trg_omie_clientes_to_ledger': 'tabela renomeada → _quarantine_omie_clientes_20260722 (20260722110000_quarentena_omie_clientes_espelho); o trigger foi junto',
  'carteira_omie_fase1::carteira_visivel_para': 'SET SCHEMA private — 20260718150000_fu7_helpers_rls_schema_privado',
  'carteira_visivel_para_filtra_eligible::carteira_visivel_para': 'SET SCHEMA private — 20260718150000_fu7_helpers_rls_schema_privado',
  'markup_policy::uq_markup_policy_conta': 'drop — 20260704120000_preco_por_tier → constraint markup_policy_escopo_tier_uq',
  'markup_policy::uq_markup_policy_fam': 'drop — 20260704120000_preco_por_tier → constraint markup_policy_escopo_tier_uq',
  'markup_policy::uq_markup_policy_sku': 'drop — 20260704120000_preco_por_tier → constraint markup_policy_escopo_tier_uq',
  'markup_policy::markup_policy_select_staff': 'substituída → markup_policy_select_carteira (20260704120000_preco_por_tier)',
  'recencia_mv_order_date_kpi::idx_customer_metrics_mv_uid': 'MV movida para private (20261001014100_universo_pedidos_recencia); o índice vive em private.customer_metrics_mv',
  'regua_preco::regua_preco_log_staff_all': 'substituída → regua_preco_log_select_custo (20260723150000_authz_custo_fu4f_fase2_regua)',
  'reposicao_alerta_pedido_minimo::Staff lê alertas de pedido mínimo': 'substituída → reposicao_alerta_pedido_minimo_sel (fu4h, DROP dinâmico pelo catálogo)',
  'reposicao_auto_aprovacao_piloto::Staff lê log de auto-aprovação': 'substituída → reposicao_auto_aprovacao_log_sel (fu4h)',
  'reposicao_auto_aprovacao_v2::Staff lê log de auto-aprovação': 'substituída → reposicao_auto_aprovacao_log_sel (fu4h)',
  'scoring_v2_signal_modifiers::Staff can insert recalc queue': 'substituída → Master can insert recalc queue (20260718100000_filas_recalc_rls_master_only)',
  'scoring_v2_signal_modifiers::Staff can view recalc queue': 'substituída → Master can view recalc queue (20260718100000_filas_recalc_rls_master_only)',
  'selfservice_pr01_allowlist_gate::ss_allowlist_gestor_iud': 'split → ss_allowlist_select/insert/update/delete (20260718190000_authz_capability_matrix_e2)',
  'visit_intelligence_v1::Staff can insert visit recalc queue': 'substituída → Master can insert visit recalc queue (20260718100000_filas_recalc_rls_master_only)',
  'visit_intelligence_v1::Staff can view visit recalc queue': 'substituída → Master can view visit recalc queue (20260718100000_filas_recalc_rls_master_only)',
  'visit_intelligence_v1::Staff can manage their visit scores': 'substituída → cvs_insert/update/delete_own_or_gestor (20260526020000_rls_score_carteira_hardening)',
  'visit_intelligence_v1::Staff can view their visit scores': 'substituída → cvs_select_carteira (20260526020000_rls_score_carteira_hardening)',
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

/**
 * Histórico ORDENADO do corpo de cada função, por `schema.nome`, ao longo de TODAS as migrations.
 *
 * 🔴 "Todas" inclui as de nome UUID, que o inventário exclui de propósito (elas são aplicadas
 * sozinhas pelo builder do Lovable e não precisam de apply manual). Aqui elas são obrigatórias, e
 * o efeito medido é COBERTURA, não falso-positivo: com as UUID, a Seção 3 vigia 98 funções; sem
 * elas, 87 — **11 saem da checagem**, entre as quais `public.fin_user_can_access`, cuja última
 * definição está justamente numa migration UUID. Nenhuma função MUDA de classificação (medido:
 * zero mudanças de status), então ignorá-las não fabrica alarme — cria silêncio, que é o modo de
 * falha mais discreto e o que este arquivo inteiro combate.
 *
 * A ordem é a lexical do nome do arquivo, que é a ordem de apply (timestamp na frente).
 */
/**
 * Deriva da Seção 3 RECONHECIDA — pelo md5 do corpo vivo, nunca pelo nome.
 *
 * DERIVA = corpo em prod que nenhuma migration declara. Boa parte é patch LEGÍTIMO que o audit não
 * enxerga por construção: envelope em `db/` (patch por âncora, `replace()` no corpo vivo) ou corpo
 * recriado sem um comentário (o hash é do `prosrc` com espaço colapsado — comentário CONTA). Cada
 * entrada abaixo foi triada em 2026-10-08 (corpo vivo × última migration, normalizados; flags de
 * SECURITY DEFINER, search_path e EXECUTE de anon/authenticated medidos): nenhuma é regressão.
 *
 * O md5 é o que torna isto seguro: reconhecer pelo NOME cegaria o audit para a próxima edição; pelo
 * HASH, qualquer mudança no corpo volta a ser 🔴 DERIVA. md5 = o da Seção 3,
 * `md5(regexp_replace(btrim(prosrc), '\s+', ' ', 'g'))`, medido via psql-ro no mesmo dia.
 *
 * ⚠️ O auditor de deriva OFICIAL é `bun run deriva:corpo:prod` (tokens, patches por âncora, baseline ACEITA
 * pelo founder em `db/deriva-corpo-baseline.json`) — ele já classificava estas 15 como em dia/cosméticas/
 * aceitas quando este mapa nasceu (descoberto depois, 2026-10-09). Este mapa só serve à visão do SQL Editor
 * desta Seção 3, que não compara tokens. Deriva NOVA se aceita lá primeiro; aqui é espelho, e os md5 têm
 * definições diferentes (lá: `md5(prosrc)` cru).
 */
const DERIVA_RECONHECIDA: Record<string, { md5: string; motivo: string }> = {
  'public.apply_score_updates': { md5: '331996f594ff3491f36ce7da9068dbd9', motivo: 'cosmética (triagem 2026-10-08)' },
  'public.aprovar_versao_boletim': { md5: '3c84eb4fc24751d4e68965aabecb9a4a', motivo: 'cosmética; has_role master preservado' },
  'public.confirmar_vinculo_boletim': { md5: '781e8e85d791fc7b01a3370ceb92e379', motivo: 'cosmética; has_role master preservado' },
  'public.detectar_skus_sem_grupo': { md5: '8e2a852f25c58fcc8afec1e421193e99', motivo: 'só o texto gravado em justificativa_decisao difere; lógica idêntica' },
  'public.fin_calcular_confiabilidade': { md5: 'b76260aca8e086b765bdc84006f00f6d', motivo: 'cosmética (triagem 2026-10-08)' },
  'public.get_customer_sales_summary': { md5: '1af8a023586be99ad188760bf8a78837', motivo: 'cosmética: corpo recriado sem um comentário SQL (conferido token a token)' },
  'public.pedido_total_liquido_converter': { md5: 'b01c8f547258a2f3ffbafdf8a6e2812e', motivo: 'patch programático por âncora — db/2026-10-05-pedido-total-liquido-excecao.sql' },
  'public.promover_candidato_primeira_compra': { md5: '76b44ddda40c0329f3785d9cbfa7b938', motivo: 'cosmética; checagem de papel preservada' },
  'public.reconciliar_pedidos_omie': { md5: '7bb459f58e37c6bc9691971f0b2aa009', motivo: 'patch por âncora — db/2026-10-06-desconto-corrigido-para-null.sql' },
  'public.resolve_markup_policy': { md5: 'dd23eedbafe99b73cd3e68462c11dbcd', motivo: 'cosmética (triagem 2026-10-08)' },
  'public.seed_targets_faltantes': { md5: '33458c80ec700367cbdf4652becf5002', motivo: 'cosmética (triagem 2026-10-08)' },
  'public.sugerir_negociacao_paralela_hoje': { md5: '534d0ddb7943af1a72bbe0f4d013ca78', motivo: 'search_path public,private via ALTER FUNCTION (20260527160000)' },
  'public.tarefas_guard_comprovacao': { md5: 'e9b5850b9f681e7061899719718bf23b', motivo: 'hardening à mão (SET search_path) sem rastro no repo — RETURNS trigger, não SECDEF' },
  'public.tarefas_materializar_recorrentes': { md5: '65b0ce06867c71934288d53858dba781', motivo: 'cosmética (triagem 2026-10-08)' },
  'public.tint_promote_sync_run': { md5: 'c33d4186be26ca4f5b08998cdfea4e5a', motivo: 'patch por replace() no corpo vivo — migrations 20260924/20260925' },
};

/**
 * Funções cujo ÚLTIMO evento no histórico de migrations é uma remoção (DROP / SET SCHEMA / RENAME)
 * sem recriação posterior → `schema.nome` (minúsculas) para a migration que a removeu.
 *
 * Mesmo arquivo com DROP e CREATE vale o CREATE (é o padrão "recriar"). No pior caso isso deixa um
 * vermelho a mais, nunca um verde falso. Varre TODAS as migrations, inclusive as UUID, como o
 * histórico de corpos — o CREATE costuma estar numa UUID e o DROP numa custom.
 */
function funcoesRemovidasPorHistorico(): Map<string, string> {
  const removidas = new Map<string, string>();
  for (const filename of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const criadas = new Set(
      extractObjects(sql).filter((o) => o.kind === 'function').map((o) => `${o.schema}.${o.name}`.toLowerCase()),
    );
    for (const k of funcoesRemovidas(sql)) if (!criadas.has(k)) removidas.set(k, filename);
    for (const k of criadas) removidas.delete(k);
  }
  return removidas;
}

function historicoDeCorpos(): Map<string, { migration: string; md5: string }[]> {
  const hist = new Map<string, { migration: string; md5: string }[]>();
  for (const filename of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const o of extractObjects(readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'))) {
      if (o.kind !== 'function' || !o.bodyMd5) continue;
      const chave = `${o.schema}.${o.name}`;
      if (!hist.has(chave)) hist.set(chave, []);
      hist.get(chave)!.push({ migration: filename, md5: o.bodyMd5 });
    }
  }
  return hist;
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
  emitSecaoCorpos(lines);
  lines.push('');
  lines.push('-- ========================================================================');
  lines.push('-- FIM');
  lines.push('-- ========================================================================');
  lines.push('');

  return lines.join('\n');
}

/**
 * Seção 3 — o ponto cego que existência NÃO cobre: objeto RECRIADO.
 *
 * As Seções 1 e 2 perguntam "o objeto existe?". Para um objeto criado por UMA migration isso
 * responde "foi aplicada?". Para um `CREATE OR REPLACE` de objeto que JÁ existia, não responde
 * nada: a função existe desde a primeira migration, e o audit devolve ✅ com ou sem o apply da
 * segunda. Medido em 2026-08-29: **231 dos 1307 objetos** do inventário (18%) são definidos por
 * mais de uma migration — e o defeito foi encontrado justamente ao mergear um
 * `CREATE OR REPLACE` de `private.cap_carteira_escrever`, que a Seção 2 aprovou sem o apply.
 *
 * O que decide é o CORPO. Três estados, e a distinção entre eles é a razão da seção existir:
 *
 *   ✅ o corpo vivo é o da ÚLTIMA migration que o define — em dia.
 *   ❌ o corpo vivo é o de uma migration ANTERIOR — a posterior NÃO foi aplicada. É o único
 *      estado que significa "falta colar SQL", e é o que a Seção 2 dava como ✅.
 *   🔴 o corpo vivo não bate com NENHUMA migration — DERIVA: alguém editou direto no SQL Editor,
 *      que é o modo normal de operar este banco. NÃO é "não aplicada", e tratar como ❌ seria
 *      fabricar 24 alarmes (medido) que mandariam colar SQL que já está aplicado.
 *
 * Só entram funções definidas por ≥2 migrations E com corpo extraível nas duas pontas. Corpo
 * não-extraível degrada para fora da seção — ausência de dado nunca vira ✅ aqui, ela vira
 * silêncio explícito no cabeçalho.
 */
function emitSecaoCorpos(lines: string[]): void {
  const hist = historicoDeCorpos();
  const removidas = funcoesRemovidasPorHistorico();
  const recriadasTodas = [...hist.entries()].filter(([, v]) => v.length > 1);
  const recriadas = recriadasTodas.filter(([chave]) => !removidas.has(chave.toLowerCase()));
  const excluidasPorRemocao = recriadasTodas.filter(([chave]) => removidas.has(chave.toLowerCase()));

  lines.push('-- =====================================================');
  lines.push('-- SEÇÃO 3: objetos RECRIADOS — existência não decide, o CORPO decide');
  lines.push('-- =====================================================');
  lines.push('-- Para função redefinida por mais de uma migration, "o objeto existe" é ✅ mesmo');
  lines.push('-- sem o apply da última. Aqui o md5 do corpo vivo é comparado com o histórico:');
  lines.push('--   ✅ em dia · ❌ NAO APLICADA (corpo é de uma migration anterior) · 🔴 DERIVA');
  lines.push('-- DERIVA (corpo que nenhuma migration declara) NÃO é "falta colar": é edição manual.');
  lines.push(`-- Funções redefinidas com corpo extraível: ${recriadas.length}.`);
  if (excluidasPorRemocao.length > 0) {
    lines.push(`-- Fora da seção (${excluidasPorRemocao.length}) — o último evento é REMOÇÃO de propósito (DROP / SET SCHEMA / RENAME):`);
    for (const [chave] of excluidasPorRemocao) lines.push(`--   • ${chave} — ${removidas.get(chave.toLowerCase())}`);
  }
  lines.push('-- ✅ deriva reconhecida = corpo vivo com o md5 EXATO triado em DERIVA_RECONHECIDA; mudou o corpo, volta a 🔴.');
  lines.push('');

  if (recriadas.length === 0) {
    lines.push('-- Nenhuma função redefinida com corpo extraível — nada a reconciliar aqui.');
    return;
  }

  const vals: string[] = [];
  for (const [chave, versoes] of recriadas) {
    const [schema, nome] = chave.split('.');
    versoes.forEach((v, i) => {
      vals.push(`  (${sqlString(schema)}, ${sqlString(nome)}, ${i + 1}, ${sqlString(v.migration)}, ${sqlString(v.md5)})`);
    });
  }
  lines.push('WITH corpo_esperado (schema_name, object_name, ordem, migration, body_md5) AS (VALUES');
  vals.forEach((v, i) => lines.push(v + (i === vals.length - 1 ? '' : ',')));
  lines.push('),');
  const reconhecidas = Object.entries(DERIVA_RECONHECIDA).map(([chave, r]) => {
    const [schema, nome] = chave.split('.');
    return `  (${sqlString(schema)}, ${sqlString(nome)}, ${sqlString(r.md5)}, ${sqlString(r.motivo)})`;
  });
  lines.push('deriva_reconhecida (schema_name, object_name, body_md5, motivo) AS (VALUES');
  reconhecidas.forEach((v, i) => lines.push(v + (i === reconhecidas.length - 1 ? '' : ',')));
  lines.push('),');
  lines.push('ultima AS (');
  lines.push('  SELECT schema_name, object_name, max(ordem) AS ordem FROM corpo_esperado GROUP BY 1, 2');
  lines.push('),');
  // Overload: mesmo nome com assinaturas diferentes vira VÁRIAS linhas aqui de propósito — o
  // regex do inventário não distingue overload no corpo, então "bate com alguma" é o critério
  // conservador (acusar overload como deriva seria falso-positivo).
  lines.push('vivo AS (');
  lines.push('  SELECT n.nspname AS schema_name, p.proname AS object_name,');
  lines.push("         md5(regexp_replace(btrim(p.prosrc), '\\s+', ' ', 'g')) AS body_md5");
  lines.push('    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace');
  lines.push("   WHERE p.prokind = 'f'");
  lines.push(')');
  lines.push('SELECT');
  lines.push("  u.schema_name || '.' || u.object_name AS object,");
  lines.push('  (SELECT ce.migration FROM corpo_esperado ce');
  lines.push('    WHERE ce.schema_name = u.schema_name AND ce.object_name = u.object_name');
  lines.push('      AND ce.ordem = u.ordem) AS ultima_migration,');
  lines.push('  CASE');
  lines.push('    WHEN NOT EXISTS (SELECT 1 FROM vivo v');
  lines.push('                      WHERE v.schema_name = u.schema_name AND v.object_name = u.object_name)');
  lines.push("      THEN '❌ AUSENTE em prod'");
  lines.push('    WHEN EXISTS (SELECT 1 FROM vivo v JOIN corpo_esperado ce');
  lines.push('                   ON ce.schema_name = v.schema_name AND ce.object_name = v.object_name');
  lines.push('                  AND ce.body_md5 = v.body_md5 AND ce.ordem = u.ordem');
  lines.push('                 WHERE v.schema_name = u.schema_name AND v.object_name = u.object_name)');
  lines.push("      THEN '✅ em dia'");
  lines.push('    WHEN EXISTS (SELECT 1 FROM vivo v JOIN corpo_esperado ce');
  lines.push('                   ON ce.schema_name = v.schema_name AND ce.object_name = v.object_name');
  lines.push('                  AND ce.body_md5 = v.body_md5');
  lines.push('                 WHERE v.schema_name = u.schema_name AND v.object_name = u.object_name)');
  lines.push("      THEN '❌ NAO APLICADA — o corpo vivo e de uma migration ANTERIOR'");
  lines.push('    WHEN EXISTS (SELECT 1 FROM vivo v JOIN deriva_reconhecida dr');
  lines.push('                   ON dr.schema_name = v.schema_name AND dr.object_name = v.object_name');
  lines.push('                  AND dr.body_md5 = v.body_md5');
  lines.push('                 WHERE v.schema_name = u.schema_name AND v.object_name = u.object_name)');
  lines.push("      THEN '✅ deriva reconhecida — ' || (SELECT dr.motivo FROM deriva_reconhecida dr");
  lines.push('                 WHERE dr.schema_name = u.schema_name AND dr.object_name = u.object_name)');
  lines.push("    ELSE '🔴 DERIVA — corpo em prod nao bate com nenhuma migration (edicao manual)'");
  lines.push('  END AS status');
  lines.push('FROM ultima u');
  lines.push('ORDER BY status, object;');
  return;
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

/**
 * Bytes UTF-8 reais de `conteudo` — a unidade que `ls -la`, `wc -c` e o git usam.
 *
 * NÃO trocar por `String.length`: ela conta unidades UTF-16, e os dois artefatos são pt-BR
 * acentuado com alguns emoji (astral ⇒ 2 unidades cada). Medido em 2026-08-22, o `.length`
 * subcontava o `.sql` em 194 bytes e o `.md` em 2.023.
 *
 * Por que importa (custo real, não estético): validar uma mudança no extrator é rodar
 * `bun run audit:migrations` e comparar o resultado com o commitado. Quem confere o número
 * deste log contra o `ls -la` conclui que o arquivo MUDOU e sai caçando uma regressão que não
 * existe — aconteceu ao entregar o #1894 e custou um ciclo de apuração até o `git diff` (vazio)
 * desempatar.
 *
 * Casa com o `writeFileSync(…, conteudo)` do `main()`, que grava em utf8 por default.
 */
function bytesUtf8(conteudo: string): number {
  return Buffer.byteLength(conteudo, 'utf8');
}

/**
 * A linha que o script imprime por artefato gravado: `✓ Escrito <caminho> (<n> bytes)`.
 *
 * É função, e não interpolação no call site, porque o bug do #1897 morava JUSTAMENTE no call
 * site (`${sql.length} bytes`) — um teste do `bytesUtf8` sozinho ficaria verde com o call
 * site errado. Com a aritmética aqui dentro, `audit-custom-migrations.test.ts` prende o número
 * ao que o filesystem enxerga, e o call site não tem mais o que errar.
 */
export function linhaArtefatoEscrito(caminho: string, conteudo: string): string {
  return `✓ Escrito ${caminho} (${bytesUtf8(conteudo)} bytes)`;
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
  console.log(linhaArtefatoEscrito(SQL_OUT, sql));

  const md = emitMarkdown(audits);
  writeFileSync(MD_OUT, md);
  console.log(linhaArtefatoEscrito(MD_OUT, md));

  const totalObjects = audits.reduce((sum, a) => sum + a.objects.length, 0);
  console.log(`\nResumo: ${audits.length} migrations, ${totalObjects} objetos esperados.`);
  console.log(`Próximo passo: abra ${basename(SQL_OUT)} no Supabase SQL Editor e rode.`);
}

if (import.meta.main) main();
