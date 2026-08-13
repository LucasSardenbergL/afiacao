/**
 * authz-grants.ts — núcleo PURO da sentinela de grants de tabelas fechadas por privilégio.
 * ============================================================================================
 *
 * Sem I/O. Consumido pela Parte C do `authz:check` (scripts/authz-gate-check.ts).
 * Spec: docs/superpowers/specs/2026-07-22-sentinela-grants-tabelas-fechadas-design.md
 *
 * O problema: `product_costs`/`omie_products` são fechadas por PRIVILÉGIO (REVOKE + GRANT SELECT),
 * não só por policy. Um GRANT futuro reabre o buraco EM SILÊNCIO — e os vetores não são teóricos:
 * migration nova, sync de schema da plataforma, ou default privilege agindo sobre objeto recriado.
 *
 * ANCORA NO FECHO em vez de modelar o estado absoluto de privilégio. Migrations registram só o
 * DELTA; o estado inicial vem do default privilege do Supabase e do baseline parqueado, que não
 * estão no repo. Simular o absoluto seria fabricar uma verdade que o repo não tem. Só interessa o
 * que aconteceu DEPOIS do fecho — "pós-âncora" = nome de arquivo lexicograficamente maior (mesmo
 * modelo last-writer da Parte A; o timestamp do nome é a ordem canônica de aplicação no projeto).
 *
 * Achados carregam CÓDIGO ASCII estável em caixa fixa; os testes casam o CÓDIGO, nunca a mensagem
 * em português (lição #1483: `grep -qi` sobre string acentuada falsifica por acidente de locale).
 */
import { stripNoise } from './authz-contract';
import type { TabelaFechada, Priv } from '../authz-tabelas-fechadas';

export type GrantCodigo =
  | 'REABERTURA'
  | 'RECRIACAO'
  | 'RLS_OFF'
  | 'ANCORA_AUSENTE'
  | 'ANCORA_NAO_DECLARADA'
  | 'FECHO_PENDENTE'
  | 'GRANT_NAO_PARSEAVEL';

export interface GrantFinding {
  level: 'error' | 'warn';
  codigo: GrantCodigo;
  /** schema.name */
  tabela: string;
  /** migration onde o achado mora, ou '—' quando não há arquivo */
  file: string;
  msg: string;
}

const TODOS_PRIV: Priv[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
];
const ROLES_VIGIADAS = ['anon', 'authenticated'] as const;

/**
 * Quebra o SQL (já sem comentários/strings, via stripNoise) em statements por ';'.
 * Dollar-quotes de função geram pedaços inofensivos: nenhum começa com GRANT nem é um GRANT
 * sobre a tabela-alvo — coberto pelo cenário 13.
 */
function statements(sql: string): string[] {
  return stripNoise(sql).split(';');
}

/** O statement fala da NOSSA tabela (schema certo, não sufixo nem homônima em outro schema)? */
function mencionaTabela(stmt: string, schema: string, name: string): boolean {
  // (?<![\w.]) barra x_name e outroschema.name ; (?:schema\.)? aceita o schema certo ; (?!\w) barra name_suffix
  const re = new RegExp(`(?<![\\w.])(?:${schema}\\.)?"?${name}"?(?!\\w)`, 'i');
  return re.test(stmt);
}

function parsePrivList(s: string): Priv[] {
  if (/\bALL\b/i.test(s)) return [...TODOS_PRIV];
  const out: Priv[] = [];
  for (const p of s.split(',')) {
    const t = p.trim().toUpperCase().replace(/\s*\([^)]*\)/, ''); // remove lista de colunas
    if ((TODOS_PRIV as string[]).includes(t)) out.push(t as Priv);
  }
  return out;
}

interface ParsedGrant {
  privs: Priv[];
  roles: string[];
  allTables: boolean;
}

/** Parseia "GRANT <privs> ON <alvo> TO <roles>". null = a forma não casou → fail-closed. */
function parseGrant(stmt: string): ParsedGrant | null {
  const m = /\bGRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/is.exec(stmt.trim());
  if (!m) return null;
  const [, privRaw, onRaw, toRaw] = m;
  const privs = parsePrivList(privRaw);
  if (privs.length === 0) return null; // privilégio irreconhecível → não garanto → fail-closed
  const roles = toRaw
    .replace(/\bWITH\s+GRANT\s+OPTION\b/i, '')
    .split(',')
    .map((r) => r.trim().replace(/"/g, '').toLowerCase())
    .filter(Boolean);
  const allTables = /\bALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(onRaw);
  return { privs, roles, allTables };
}

/**
 * Gate estático: para cada tabela da allowlist, vigia o que veio DEPOIS do fecho.
 *
 * @param existingFiles arquivos presentes em supabase/migrations/. Default: os das `migrations`.
 *   Existe separado para que o teste de ANCORA_AUSENTE possa simular a âncora sumindo do repo.
 */
export function auditGrantsTabelas(
  migrations: { file: string; sql: string }[],
  allowlist: Record<string, TabelaFechada>,
  existingFiles?: Set<string>,
): GrantFinding[] {
  const out: GrantFinding[] = [];
  const ordered = [...migrations].sort((a, b) => a.file.localeCompare(b.file));
  const files = existingFiles ?? new Set(ordered.map((m) => m.file));

  for (const [chave, entry] of Object.entries(allowlist)) {
    const [schema, name] = chave.split('.');

    // (1) Existe REVOKE ... FROM authenticated sobre a tabela em ALGUMA migration? Detecta o fecho
    //     sozinho — é o que impede o warn eterno de §5.2 (allowlist mentindo sobre o repo).
    let revokeFile: string | null = null;
    for (const m of ordered) {
      for (const st of statements(m.sql)) {
        if (/^\s*REVOKE\b/i.test(st) && mencionaTabela(st, schema, name) && /\bauthenticated\b/i.test(st)) {
          revokeFile = m.file;
          break;
        }
      }
      if (revokeFile) break;
    }

    // (2) Estado da âncora.
    if (entry.fechadaPor === null) {
      if (revokeFile) {
        out.push({
          level: 'error',
          codigo: 'ANCORA_NAO_DECLARADA',
          tabela: chave,
          file: revokeFile,
          msg: `REVOKE de authenticated sobre ${chave} presente em ${revokeFile}, mas fechadaPor=null. O fecho mergeou — declare a âncora em scripts/authz-tabelas-fechadas.ts.`,
        });
      } else {
        out.push({
          level: 'warn',
          codigo: 'FECHO_PENDENTE',
          tabela: chave,
          file: '—',
          msg: `fecho de ${chave} ainda PENDENTE (fechadaPor=null). ${entry.motivo}`,
        });
      }
      continue;
    }
    if (!files.has(entry.fechadaPor)) {
      out.push({
        level: 'error',
        codigo: 'ANCORA_AUSENTE',
        tabela: chave,
        file: entry.fechadaPor,
        msg: `fechadaPor aponta ${entry.fechadaPor}, ausente de supabase/migrations/. O fecho foi revertido ou renomeado?`,
      });
      continue;
    }

    // (3) Pós-âncora: só migrations com nome lexicograficamente maior que a âncora.
    for (const m of ordered) {
      if (m.file.localeCompare(entry.fechadaPor) <= 0) continue;
      for (const stRaw of statements(m.sql)) {
        const st = stRaw.trim();
        if (!st) continue;

        // RECRIACAO fecha o vetor mais traiçoeiro: DROP + CREATE faz a tabela RENASCER com o
        // default privilege aberto do Supabase, sem nenhum GRANT explícito no diff.
        if (/^CREATE\s+TABLE\b/i.test(st) && mencionaTabela(st, schema, name)) {
          out.push({
            level: 'error',
            codigo: 'RECRIACAO',
            tabela: chave,
            file: m.file,
            msg: `CREATE TABLE de ${chave} após o fecho — a tabela renasce com o default privilege aberto do Supabase.`,
          });
          continue;
        }
        if (
          /^ALTER\s+TABLE\b/i.test(st) &&
          mencionaTabela(st, schema, name) &&
          /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(st)
        ) {
          out.push({
            level: 'error',
            codigo: 'RLS_OFF',
            tabela: chave,
            file: m.file,
            msg: `DISABLE ROW LEVEL SECURITY em ${chave} após o fecho.`,
          });
          continue;
        }
        if (/^GRANT\b/i.test(st)) {
          const g = parseGrant(st);
          const mencao = mencionaTabela(st, schema, name);
          if (!g) {
            // fail-closed: se o parser não entende um statement que menciona a tabela protegida,
            // ele NÃO pode afirmar que está tudo bem.
            if (mencao) {
              out.push({
                level: 'error',
                codigo: 'GRANT_NAO_PARSEAVEL',
                tabela: chave,
                file: m.file,
                msg: `GRANT menciona ${chave} numa forma que o parser não entendeu — não posso garantir que não reabre (fail-closed). Ajuste scripts/lib/authz-grants.ts.`,
              });
            }
            continue;
          }
          if (!g.allTables && !mencao) continue; // GRANT de outra tabela/função
          for (const role of ROLES_VIGIADAS) {
            if (!g.roles.includes(role)) continue;
            const permit = entry.permitido[role] ?? [];
            const extra = g.privs.filter((p) => !permit.includes(p));
            if (extra.length) {
              out.push({
                level: 'error',
                codigo: 'REABERTURA',
                tabela: chave,
                file: m.file,
                msg: `GRANT ${extra.join(',')} a ${role} sobre ${chave}${g.allTables ? ' (via ALL TABLES IN SCHEMA)' : ''} após o fecho — fora do permitido [${permit.join(',') || 'nenhum'}].`,
              });
            }
          }
        }
      }
    }
  }
  return out;
}
