# Sentinela de grants — tabelas deliberadamente fechadas — Plano de implementação

> **Estado em 2026-08-13:** Tasks **1–3 ENTREGUES** (allowlist com âncora corrigida, `auditGrantsTabelas`
> + 14 cenários, Parte C no `authz:check`). Tasks **4–7 PENDENTES** (audit de prod sob `psql-ro`,
> harness PG17, doc). Duas correções que o plano original não podia prever — ver a "Atualização
> 2026-08-13" no spec:
> 1. `omie_products` **fechou em prod** (PR #1558, 23/07) → a entrada nasce com âncora preenchida,
>    não `fechadaPor: null` como a Task 1 escreveu.
> 2. A Task 3 mandava injetar a Parte C **dentro** de `auditAuthz`. Com uma âncora declarada isso
>    quebra os 12 testes de fixture da Parte A/B (disparam `ANCORA_AUSENTE`). A Parte C virou
>    `auditGrants`, e `auditCompleto` compõe A+B+C para o `main()`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vigiar, por allowlist curada, que tabelas fechadas por privilégio (`product_costs`, `omie_products`) não sejam reabertas em silêncio — um gate estático no CI e um audit de prod on-demand, compartilhando a mesma fonte de verdade.

**Architecture:** Uma allowlist TypeScript (`scripts/authz-tabelas-fechadas.ts`) é consumida por duas guardas. O **gate estático** (`auditGrantsTabelas`, núcleo puro em `scripts/lib/authz-grants.ts`) varre `supabase/migrations/*.sql` procurando reabertura pós-fecho e entra como **Parte C** no comando `authz:check` já existente no CI. O **audit de prod** (`db/audit-grants-tabelas-fechadas.ts`, sob `psql-ro`) mede `has_table_privilege` no banco real e compara com o contrato via `compararGrantsProd` (também puro). Cada guarda tem teste de dente próprio; os achados carregam código ASCII estável.

**Tech Stack:** TypeScript, Bun (runtime dos scripts e do audit), vitest (testes do núcleo puro), Postgres 17 local + bash (teste de dente do audit), `psql-ro` (leitura de prod).

## Global Constraints

- **Idioma:** todo texto de usuário, comentário e mensagem em **português brasileiro**. Nomes de código/identificadores podem ser pt-BR (convenção do repo).
- **Comandos pesados:** prefixar `heavy` em `test`/`typecheck`/`build`/`vitest` (semáforo de RAM da M2 8GB).
- **Exit code:** nunca `| tail` (engole o exit code). Use `> log 2>&1; echo $?` e leia a **evidência positiva** (o comando terminou + exit 0). Ausência de sinal não é aprovação.
- **Falsificação (money-path):** toda guarda precisa de teste de dente — sabotar e exigir vermelho. Os testes casam **código ASCII em caixa fixa** (ex.: `REABERTURA`), **nunca** a mensagem em português, e **sem `grep -i`** (lição #1483: matching acentuado falsifica por acidente de locale). O harness bash roda sob `LC_ALL=C` (como o precedente `db/test-audit-anon-dml-bypass.sh`).
- **vitest canônico:** `bun run test` (é o que o CI roda). `vitest.config.ts` já inclui `scripts/**/*.test.ts`.
- **`scripts/` fora do manifesto de módulos:** confirmado — arquivo novo em `scripts/` não precisa de dono em `src/lib/modulos/manifesto.ts`.
- **Não muda privilégio nenhum:** esta entrega só vigia. Nenhuma migration nova em `supabase/migrations/`.
- **Fonte da verdade única:** a allowlist é importada pelo gate e pelo audit; nunca duplicada.

---

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `scripts/authz-tabelas-fechadas.ts` | Tipos (`Priv`, `TabelaFechada`) + allowlist curada `AUTHZ_TABELAS_FECHADAS`. Dados + contrato. | 1 |
| `scripts/lib/authz-grants.ts` | Lógica **pura**: `auditGrantsTabelas` (gate estático) + `compararGrantsProd` (audit) + tipo `GrantFinding`. Sem I/O. | 2, 4 |
| `scripts/authz-grants.test.ts` | vitest do núcleo puro (gate estático + comparação de prod). | 2, 4 |
| `scripts/authz-gate-check.ts` | Integra a Parte C: chama `auditGrantsTabelas`, converte para `Finding`. | 3 |
| `scripts/authz-gate-check.test.ts` | +1 teste de integração da Parte C. | 3 |
| `db/audit-grants-tabelas-fechadas.ts` | Executável: importa allowlist, mede prod via `psql-ro`, chama `compararGrantsProd`, imprime, exit 0/1/2. | 5 |
| `db/test-audit-grants-tabelas-fechadas.sh` | Teste de dente PG17 do audit (cria fechada→limpo; abre→acusa; revoga→some). | 6 |
| `package.json` | Script `authz:grants:prod` (conveniência). | 5 |
| `docs/agent/database.md`, `docs/historico/` | Resíduo durável. | 7 |

---

## Task 1: Allowlist curada + contrato de tipos

**Files:**
- Create: `scripts/authz-tabelas-fechadas.ts`
- Test: `scripts/authz-grants.test.ts` (só o bloco de sanidade da allowlist neste task)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type Priv = 'SELECT'|'INSERT'|'UPDATE'|'DELETE'|'TRUNCATE'|'REFERENCES'|'TRIGGER'|'MAINTAIN'`
  - `interface TabelaFechada { fechadaPor: string | null; permitido: { anon: Priv[]; authenticated: Priv[] }; motivo: string }`
  - `const AUTHZ_TABELAS_FECHADAS: Record<string, TabelaFechada>` — chave = `schema.name` minúsculo.

- [ ] **Step 1: Escrever o arquivo de allowlist**

Create `scripts/authz-tabelas-fechadas.ts`:

```ts
/**
 * authz-tabelas-fechadas.ts — allowlist CURADA de tabelas fechadas por PRIVILÉGIO.
 * ============================================================================================
 *
 * Fonte de verdade única do gate estático (scripts/lib/authz-grants.ts → Parte C do authz:check)
 * e do audit de prod (db/audit-grants-tabelas-fechadas.ts). Vigia SÓ as tabelas listadas aqui.
 *
 * NÃO é varredura em massa: o grant DML amplo do Supabase (arwdDxtm a anon/authenticated em toda
 * relação nova) é o MODELO da plataforma — inócuo sob RLS + security_invoker (database.md §7).
 * Só entra aqui a tabela que foi DELIBERADAMENTE fechada por REVOKE + GRANT SELECT + policy.
 *
 * Como adicionar uma tabela: (1) confirme que ela foi fechada por privilégio; (2) declare o
 * `permitido` por role — o que NÃO estiver na lista é proibido (allowlist, fail-closed); (3)
 * quando a migration de fecho estiver no repo, aponte `fechadaPor` para o arquivo dela. Enquanto
 * o fecho não mergeou, deixe `fechadaPor: null` (o gate avisa; ver GrantCodigo FECHO_PENDENTE).
 *
 * Estado medido em prod via psql-ro (2026-07-22): as DUAS abaixo ainda estão ABERTAS
 * (anon=arwdDxtm, authenticated=arwdDxtm) — os fechos são PRs draft nunca aplicados. Por isso
 * ambas nascem com fechadaPor=null: a sentinela sabe que o fecho está pendente.
 */

export type Priv =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN'; // MAINTAIN: Postgres 17+

export interface TabelaFechada {
  /** Migration que FECHOU a tabela (âncora, nome do arquivo em supabase/migrations/).
   *  null = fecho declarado PENDENTE (ainda não mergeado). */
  fechadaPor: string | null;
  /** Privilégios PERMITIDOS por role. Ausente da lista = proibido (allowlist de privilégio). */
  permitido: { anon: Priv[]; authenticated: Priv[] };
  motivo: string;
}

export const AUTHZ_TABELAS_FECHADAS: Record<string, TabelaFechada> = {
  'public.product_costs': {
    fechadaPor: null,
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'custo unitário — fechada pelo PR #1520 (FU4-F fase 3), draft. Leitura por private.cap_custo_ler; ' +
      'escrita exclusiva de service_role (sync-reprocess, omie-analytics-sync).',
  },
  'public.omie_products': {
    fechadaPor: null,
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'preço de tabela (valor_unitario) — fechada pela branch authz-preco-fecha-omie-products, draft. ' +
      'Leitura por staff (master OR employee); escrita exclusiva de service_role (6 edges de sync do Omie).',
  },
};
```

- [ ] **Step 2: Escrever o teste de sanidade da allowlist**

Create `scripts/authz-grants.test.ts` (só este bloco por ora; Tasks 2 e 4 adicionam os demais):

```ts
import { describe, it, expect } from 'vitest';
import { AUTHZ_TABELAS_FECHADAS, type TabelaFechada } from './authz-tabelas-fechadas';

describe('AUTHZ_TABELAS_FECHADAS — sanidade do contrato', () => {
  it('tem as duas tabelas money-path fechadas por privilégio', () => {
    expect(Object.keys(AUTHZ_TABELAS_FECHADAS).sort()).toEqual([
      'public.omie_products',
      'public.product_costs',
    ]);
  });

  it('toda entrada tem permitido para anon e authenticated e um motivo não-vazio', () => {
    for (const [chave, e] of Object.entries(AUTHZ_TABELAS_FECHADAS) as [string, TabelaFechada][]) {
      expect(Array.isArray(e.permitido.anon), chave).toBe(true);
      expect(Array.isArray(e.permitido.authenticated), chave).toBe(true);
      expect(e.motivo.length, chave).toBeGreaterThan(10);
    }
  });

  it('chave está em minúsculo e no formato schema.name', () => {
    for (const chave of Object.keys(AUTHZ_TABELAS_FECHADAS)) {
      expect(chave).toBe(chave.toLowerCase());
      expect(chave.split('.')).toHaveLength(2);
    }
  });
});
```

- [ ] **Step 3: Rodar o teste — deve passar**

Run: `heavy bun run test scripts/authz-grants.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"`
Expected: termina com `EXIT=0`; log mostra 3 testes passando em `authz-grants.test.ts`.

- [ ] **Step 4: Typecheck**

Run: `heavy bun run typecheck > /tmp/tc1.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/authz-tabelas-fechadas.ts scripts/authz-grants.test.ts
git commit -m "feat(authz): allowlist curada de tabelas fechadas por privilégio [money-path]

product_costs e omie_products, ambas fechadas por REVOKE+GRANT SELECT (não por
policy). Fonte única que o gate estático e o audit de prod vão consumir. Nascem
com fechadaPor=null: medido em prod (psql-ro), os dois fechos são PRs draft ainda
não aplicados.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Gate estático — `auditGrantsTabelas` (núcleo puro) + falsificação vitest

**Files:**
- Create: `scripts/lib/authz-grants.ts`
- Modify: `scripts/authz-grants.test.ts` (adiciona o bloco do gate estático)

**Interfaces:**
- Consumes: `TabelaFechada`, `Priv` de `../authz-tabelas-fechadas`; `stripNoise` de `./authz-contract`.
- Produces:
  - `type GrantCodigo = 'REABERTURA'|'RECRIACAO'|'RLS_OFF'|'ANCORA_AUSENTE'|'ANCORA_NAO_DECLARADA'|'FECHO_PENDENTE'|'GRANT_NAO_PARSEAVEL'|'NAO_APLICADA'|'DRIFT_PROD'`
  - `interface GrantFinding { level: 'error'|'warn'; codigo: GrantCodigo; tabela: string; file: string; msg: string }`
  - `function auditGrantsTabelas(migrations: {file:string; sql:string}[], allowlist: Record<string,TabelaFechada>, existingFiles?: Set<string>): GrantFinding[]`
  - `parseGrant`/`mencionaTabela` são **internos** (não exportados) — nenhum teste os chama direto, e export sem consumidor vira dead-export para o `knip`.

- [ ] **Step 1: Escrever os testes do gate estático (falham primeiro)**

Adicione ao fim de `scripts/authz-grants.test.ts`:

```ts
import { auditGrantsTabelas, type GrantFinding } from './lib/authz-grants';

const AL = {
  'public.product_costs': {
    fechadaPor: '20260725130000_fecha_product_costs.sql',
    permitido: { anon: [], authenticated: ['SELECT'] as const },
    motivo: 'custo',
  },
} as any;
const AL_PENDENTE = {
  'public.product_costs': { fechadaPor: null, permitido: { anon: [], authenticated: ['SELECT'] }, motivo: 'custo' },
} as any;

const mig = (file: string, sql: string) => ({ file, sql });
const codigos = (f: GrantFinding[]) => f.map((x) => x.codigo).sort();
// existingFiles inclui a âncora + os arquivos passados, salvo teste de ANCORA_AUSENTE
const files = (...fs: string[]) => new Set(['20260725130000_fecha_product_costs.sql', ...fs]);

describe('auditGrantsTabelas — gate estático de reabertura', () => {
  it('1. GRANT INSERT a authenticated pós-âncora → REABERTURA', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_reabre.sql', 'GRANT INSERT ON TABLE public.product_costs TO authenticated;')],
      AL, files('20260801000000_reabre.sql'),
    );
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('REABERTURA');
    expect(f[0].level).toBe('error');
  });

  it('2. GRANT INSERT idêntico ANTES da âncora → silêncio (fecho venceu)', () => {
    const f = auditGrantsTabelas(
      [mig('20260101000000_antigo.sql', 'GRANT INSERT ON TABLE public.product_costs TO authenticated;')],
      AL, files('20260101000000_antigo.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('3. GRANT ALL a service_role pós-âncora → silêncio (é o writer)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_svc.sql', 'GRANT ALL ON TABLE public.product_costs TO service_role;')],
      AL, files('20260801000000_svc.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('4. GRANT SELECT a authenticated pós-âncora → silêncio (dentro do permitido)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_sel.sql', 'GRANT SELECT ON TABLE public.product_costs TO authenticated;')],
      AL, files('20260801000000_sel.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('5. CREATE TABLE da tabela pós-âncora → RECRIACAO', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_recria.sql', 'CREATE TABLE public.product_costs (id int primary key);')],
      AL, files('20260801000000_recria.sql'),
    );
    expect(codigos(f)).toContain('RECRIACAO');
  });

  it('6. DISABLE ROW LEVEL SECURITY pós-âncora → RLS_OFF', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_rls.sql', 'ALTER TABLE public.product_costs DISABLE ROW LEVEL SECURITY;')],
      AL, files('20260801000000_rls.sql'),
    );
    expect(codigos(f)).toContain('RLS_OFF');
  });

  it('7. âncora aponta arquivo inexistente → ANCORA_AUSENTE', () => {
    const f = auditGrantsTabelas([], AL, new Set()); // âncora não está nos arquivos
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('ANCORA_AUSENTE');
  });

  it('8. fechadaPor=null sem REVOKE no repo → FECHO_PENDENTE (warn)', () => {
    const f = auditGrantsTabelas([mig('20260101_x.sql', 'SELECT 1;')], AL_PENDENTE, new Set(['20260101_x.sql']));
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('FECHO_PENDENTE');
    expect(f[0].level).toBe('warn');
  });

  it('9. GRANT da tabela DENTRO de comentário → silêncio (stripNoise)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_comentado.sql', '-- GRANT INSERT ON TABLE public.product_costs TO authenticated;\nSELECT 1;')],
      AL, files('20260801000000_comentado.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('10. fechadaPor=null MAS REVOKE ... FROM authenticated no repo → ANCORA_NAO_DECLARADA', () => {
    const f = auditGrantsTabelas(
      [mig('20260725130000_fecha.sql', 'REVOKE ALL ON TABLE public.product_costs FROM authenticated;')],
      AL_PENDENTE, new Set(['20260725130000_fecha.sql']),
    );
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('ANCORA_NAO_DECLARADA');
    expect(f[0].level).toBe('error');
  });

  it('11. GRANT ALL TABLES IN SCHEMA public a authenticated pós-âncora → REABERTURA', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_massa.sql', 'GRANT INSERT ON ALL TABLES IN SCHEMA public TO authenticated;')],
      AL, files('20260801000000_massa.sql'),
    );
    expect(codigos(f)).toContain('REABERTURA');
  });

  it('12. GRANT a authenticated em forma não-parseável mencionando a tabela → GRANT_NAO_PARSEAVEL', () => {
    // "TO" ausente após a tabela: menciona a tabela num GRANT mas parseGrant não casa
    const f = auditGrantsTabelas(
      [mig('20260801000000_estranho.sql', 'GRANT INSERT ON public.product_costs;')],
      AL, files('20260801000000_estranho.sql'),
    );
    expect(codigos(f)).toContain('GRANT_NAO_PARSEAVEL');
  });

  it('13. função com ; no corpo + GRANT limpo na mesma migration → não confunde', () => {
    const sql = `CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RETURN 2; END; $$;
GRANT SELECT ON TABLE public.product_costs TO authenticated;`;
    const f = auditGrantsTabelas([mig('20260801000000_mista.sql', sql)], AL, files('20260801000000_mista.sql'));
    expect(f).toHaveLength(0); // SELECT é permitido; o ; do corpo não vira falso GRANT
  });

  it('14. não vaza para outra tabela homônima em outro schema', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_outra.sql', 'GRANT INSERT ON TABLE outros.product_costs TO authenticated;')],
      AL, files('20260801000000_outra.sql'),
    );
    expect(f).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar (módulo não existe)**

Run: `heavy bun run test scripts/authz-grants.test.ts > /tmp/t2.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT` ≠ 0; erro de import `./lib/authz-grants` não encontrado.

- [ ] **Step 3: Implementar `scripts/lib/authz-grants.ts`**

Create `scripts/lib/authz-grants.ts`:

```ts
/**
 * authz-grants.ts — núcleo PURO da sentinela de grants de tabelas fechadas.
 * ============================================================================================
 * Sem I/O. Duas funções:
 *   · auditGrantsTabelas(migrations, allowlist, existingFiles?) — gate estático (Parte C do CI).
 *     Ancora no fecho: só vigia o que veio DEPOIS da migration-âncora (ordem = nome do arquivo).
 *   · compararGrantsProd(medido, allowlist) — comparação do audit de prod (Task 4).
 * Achados carregam CÓDIGO ASCII estável; testes casam o código, nunca a mensagem (lição #1483).
 */
import { stripNoise } from './authz-contract';
import type { TabelaFechada, Priv } from '../authz-tabelas-fechadas';

export type GrantCodigo =
  | 'REABERTURA' | 'RECRIACAO' | 'RLS_OFF'
  | 'ANCORA_AUSENTE' | 'ANCORA_NAO_DECLARADA'
  | 'FECHO_PENDENTE' | 'GRANT_NAO_PARSEAVEL'
  | 'NAO_APLICADA' | 'DRIFT_PROD';

export interface GrantFinding {
  level: 'error' | 'warn';
  codigo: GrantCodigo;
  tabela: string; // schema.name
  file: string; // migration ou '—'/'(prod)'
  msg: string;
}

const TODOS_PRIV: Priv[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const ROLES_VIGIADAS = ['anon', 'authenticated'] as const;

/** quebra o SQL (já sem comentários/strings) em statements por ';'. Dollar-quotes de função
 *  geram pedaços inofensivos: nenhum começa com GRANT nem é um GRANT sobre a tabela-alvo. */
function statements(sql: string): string[] {
  return stripNoise(sql).split(';');
}

/** o identificador da tabela aparece no statement como a NOSSA tabela (schema certo, não sufixo)? */
function mencionaTabela(stmt: string, schema: string, name: string): boolean {
  // (?<![\w.]) evita x_name e outroschema.name ; (?:schema\.)? aceita o schema certo ; (?![\w]) evita name_suffix
  const re = new RegExp(`(?<![\\w.])(?:${schema}\\.)?"?${name}"?(?![\\w])`, 'i');
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
/** parseia "GRANT <privs> ON <alvo> TO <roles>" ; null se a forma não casar (→ fail-closed) */
function parseGrant(stmt: string): ParsedGrant | null {
  const m = /\bGRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/is.exec(stmt.trim());
  if (!m) return null;
  const [, privRaw, onRaw, toRaw] = m;
  const privs = parsePrivList(privRaw);
  if (privs.length === 0) return null; // GRANT sem privilégio reconhecível → não garanto → fail-closed
  const roles = toRaw
    .replace(/\bWITH\s+GRANT\s+OPTION\b/i, '')
    .split(',')
    .map((r) => r.trim().replace(/"/g, '').toLowerCase())
    .filter(Boolean);
  const allTables = /\bALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(onRaw);
  return { privs, roles, allTables };
}

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

    // (1) há REVOKE ... FROM authenticated sobre a tabela em ALGUMA migration? (detecta o fecho)
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

    // (2) estado da âncora
    if (entry.fechadaPor === null) {
      if (revokeFile) {
        out.push({
          level: 'error', codigo: 'ANCORA_NAO_DECLARADA', tabela: chave, file: revokeFile,
          msg: `REVOKE de authenticated sobre ${chave} presente em ${revokeFile}, mas fechadaPor=null. O fecho mergeou — declare a âncora em scripts/authz-tabelas-fechadas.ts.`,
        });
      } else {
        out.push({
          level: 'warn', codigo: 'FECHO_PENDENTE', tabela: chave, file: '—',
          msg: `fecho de ${chave} ainda PENDENTE (fechadaPor=null). ${entry.motivo}`,
        });
      }
      continue;
    }
    if (!files.has(entry.fechadaPor)) {
      out.push({
        level: 'error', codigo: 'ANCORA_AUSENTE', tabela: chave, file: entry.fechadaPor,
        msg: `fechadaPor aponta ${entry.fechadaPor}, ausente de supabase/migrations/. O fecho foi revertido ou renomeado?`,
      });
      continue;
    }

    // (3) pós-âncora: só migrations com nome lexicograficamente maior que a âncora
    for (const m of ordered) {
      if (m.file.localeCompare(entry.fechadaPor) <= 0) continue;
      for (const stRaw of statements(m.sql)) {
        const st = stRaw.trim();
        if (!st) continue;

        if (/^CREATE\s+TABLE\b/i.test(st) && mencionaTabela(st, schema, name)) {
          out.push({
            level: 'error', codigo: 'RECRIACAO', tabela: chave, file: m.file,
            msg: `CREATE TABLE de ${chave} após o fecho — a tabela renasce com o default privilege aberto do Supabase.`,
          });
          continue;
        }
        if (/^ALTER\s+TABLE\b/i.test(st) && mencionaTabela(st, schema, name) && /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(st)) {
          out.push({
            level: 'error', codigo: 'RLS_OFF', tabela: chave, file: m.file,
            msg: `DISABLE ROW LEVEL SECURITY em ${chave} após o fecho.`,
          });
          continue;
        }
        if (/^GRANT\b/i.test(st)) {
          const g = parseGrant(st);
          const mencao = mencionaTabela(st, schema, name);
          if (!g) {
            if (mencao) {
              out.push({
                level: 'error', codigo: 'GRANT_NAO_PARSEAVEL', tabela: chave, file: m.file,
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
                level: 'error', codigo: 'REABERTURA', tabela: chave, file: m.file,
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
```

- [ ] **Step 4: Rodar — os 14 devem passar**

Run: `heavy bun run test scripts/authz-grants.test.ts > /tmp/t2b.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`; log mostra 14 testes do bloco "gate estático" + 3 de sanidade passando.

- [ ] **Step 5: Typecheck**

Run: `heavy bun run typecheck > /tmp/tc2.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/authz-grants.ts scripts/authz-grants.test.ts
git commit -m "feat(authz): gate estático de reabertura de grant (núcleo puro) [money-path]

auditGrantsTabelas ancora no fecho e vigia só o pós-âncora: REABERTURA (GRANT fora
do permitido, inclusive ALL TABLES IN SCHEMA), RECRIACAO, RLS_OFF, ANCORA_AUSENTE,
ANCORA_NAO_DECLARADA, FECHO_PENDENTE, GRANT_NAO_PARSEAVEL (fail-closed). 14 cenários,
metade deles casos que devem passar batido. Códigos ASCII; testes casam código.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Integrar a Parte C no `authz:check` (CI)

**Files:**
- Modify: `scripts/authz-gate-check.ts` (importa + chama `auditGrantsTabelas`, converte `GrantFinding`→`Finding`)
- Modify: `scripts/authz-gate-check.test.ts` (+1 teste de integração)

**Interfaces:**
- Consumes: `auditGrantsTabelas`, `GrantFinding` de `./lib/authz-grants`; `AUTHZ_TABELAS_FECHADAS` de `./authz-tabelas-fechadas`.
- Produces: `auditAuthz` passa a incluir os grant-findings convertidos (o `main()` existente já os imprime e falha em erro).

- [ ] **Step 1: Escrever o teste de integração (falha primeiro)**

Adicione ao fim de `scripts/authz-gate-check.test.ts`:

```ts
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';

describe('auditAuthz — Parte C (grants de tabela fechada)', () => {
  it('inclui FECHO_PENDENTE (warn) para as tabelas com fechadaPor=null do manifesto real', () => {
    // hoje as duas nascem pendentes → dois warns, zero erros vindos da Parte C
    const f = auditAuthz([mig('20260101000000_noop.sql', 'SELECT 1;')]);
    const pend = f.filter((x) => x.msg.includes('FECHO_PENDENTE'));
    expect(pend.length).toBe(Object.values(AUTHZ_TABELAS_FECHADAS).filter((e) => e.fechadaPor === null).length);
    expect(pend.every((x) => x.level === 'warn')).toBe(true);
  });

  it('a msg convertida carrega o código ASCII (não a frase pt-BR)', () => {
    const f = auditAuthz([mig('20260101000000_noop.sql', 'SELECT 1;')]);
    expect(f.some((x) => /\[FECHO_PENDENTE\]/.test(x.msg))).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar (Parte C ainda não existe)**

Run: `heavy bun run test scripts/authz-gate-check.test.ts > /tmp/t3.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT` ≠ 0 — o teste "Parte C" falha (nenhum finding com `FECHO_PENDENTE`).

- [ ] **Step 3: Integrar no `auditAuthz`**

Em `scripts/authz-gate-check.ts`, adicione ao bloco de imports (após a linha que importa de `./authz-manifest`):

```ts
import { auditGrantsTabelas } from './lib/authz-grants';
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';
```

Depois, dentro de `auditAuthz`, imediatamente antes de `return findings;`, insira:

```ts
  // Parte C — grants de tabela fechada por privilégio (allowlist curada). Núcleo puro em
  // scripts/lib/authz-grants.ts; aqui só convertemos GrantFinding→Finding, prefixando o CÓDIGO
  // ASCII na msg para que ele apareça no log do CI (e nos testes que casam por código).
  const filesPresentes = new Set(ordered.map((m) => m.file));
  for (const gf of auditGrantsTabelas(migrations, AUTHZ_TABELAS_FECHADAS, filesPresentes)) {
    findings.push({ level: gf.level, file: gf.file, fn: gf.tabela, msg: `[${gf.codigo}] ${gf.msg}` });
  }
```

- [ ] **Step 4: Rodar os testes do gate — tudo verde**

Run: `heavy bun run test scripts/authz-gate-check.test.ts scripts/authz-grants.test.ts > /tmp/t3b.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`; os testes das Partes A, B e C passam.

- [ ] **Step 5: Rodar o comando de CI de verdade — verde com 2 avisos**

Run: `bun run authz:check > /tmp/ac.log 2>&1; echo "EXIT=$?"; cat /tmp/ac.log`
Expected: `EXIT=0`. O stdout mostra 2 avisos `[FECHO_PENDENTE]` (product_costs, omie_products) e a linha final `✅ authz:check … verdes.`. **Evidência positiva:** exit 0 **e** as duas linhas de aviso presentes.

- [ ] **Step 6: Suíte completa + typecheck (nada regrediu)**

Run: `heavy bun run test > /tmp/t3full.log 2>&1; echo "EXIT=$?"`
Then: `heavy bun run typecheck > /tmp/tc3.log 2>&1; echo "EXIT=$?"`
Expected: ambos `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/authz-gate-check.ts scripts/authz-gate-check.test.ts
git commit -m "feat(authz): Parte C do authz:check vigia grants de tabela fechada [money-path]

auditAuthz passa a incluir os achados de auditGrantsTabelas, convertidos para Finding
com o código ASCII prefixado na msg. Reusa o step de CI existente — zero superfície
nova no ci.yml. Hoje: 2 avisos FECHO_PENDENTE, exit 0.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Comparação de prod — `compararGrantsProd` (núcleo puro) + vitest

**Files:**
- Modify: `scripts/lib/authz-grants.ts` (adiciona `compararGrantsProd`)
- Modify: `scripts/authz-grants.test.ts` (bloco de comparação de prod)

**Interfaces:**
- Consumes: `TabelaFechada`, `Priv`, `GrantFinding`, `GrantCodigo`.
- Produces:
  - `type MedicaoProd = Record<string, Partial<Record<'anon'|'authenticated', Priv[]>>>` (tabela → role → privilégios PRESENTES em prod)
  - `function compararGrantsProd(medido: MedicaoProd, allowlist: Record<string,TabelaFechada>): GrantFinding[]`

- [ ] **Step 1: Escrever os testes (falham primeiro)**

Adicione ao fim de `scripts/authz-grants.test.ts`:

```ts
import { compararGrantsProd, type MedicaoProd } from './lib/authz-grants';

const AL_FECHADA = {
  'public.product_costs': {
    fechadaPor: '20260725130000_fecha_product_costs.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo: 'custo',
  },
} as any;

describe('compararGrantsProd — audit de prod (puro)', () => {
  it('estado fechado (só SELECT p/ authenticated) → limpo', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: [], authenticated: ['SELECT'] } };
    expect(compararGrantsProd(m, AL_FECHADA)).toHaveLength(0);
  });

  it('authenticated ainda com INSERT+UPDATE+DELETE → NAO_APLICADA', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: ['SELECT'], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } };
    const f = compararGrantsProd(m, AL_FECHADA);
    expect(f.some((x) => x.codigo === 'NAO_APLICADA')).toBe(true);
    expect(f.every((x) => x.level === 'error')).toBe(true);
  });

  it('grant parcial à mão (só INSERT) → DRIFT_PROD, não NAO_APLICADA', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: [], authenticated: ['SELECT', 'INSERT'] } };
    const f = compararGrantsProd(m, AL_FECHADA);
    expect(f.some((x) => x.codigo === 'DRIFT_PROD')).toBe(true);
    expect(f.some((x) => x.codigo === 'NAO_APLICADA')).toBe(false);
  });

  it('anon com SELECT (fora do permitido []) → achado', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: ['SELECT'], authenticated: ['SELECT'] } };
    const f = compararGrantsProd(m, AL_FECHADA);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].tabela).toBe('public.product_costs');
  });

  it('fechadaPor=null → FECHO_PENDENTE (warn), não compara', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: ['INSERT'], authenticated: ['INSERT'] } };
    const f = compararGrantsProd(m, AL_PENDENTE);
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('FECHO_PENDENTE');
    expect(f[0].level).toBe('warn');
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `heavy bun run test scripts/authz-grants.test.ts > /tmp/t4.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT` ≠ 0 — import `compararGrantsProd`/`MedicaoProd` inexistente.

- [ ] **Step 3: Implementar `compararGrantsProd`**

Em `scripts/lib/authz-grants.ts`, adicione ao fim:

```ts
export type MedicaoProd = Record<string, Partial<Record<(typeof ROLES_VIGIADAS)[number], Priv[]>>>;

/** compara o estado MEDIDO em prod (privilégios presentes por role) com o contrato. */
export function compararGrantsProd(medido: MedicaoProd, allowlist: Record<string, TabelaFechada>): GrantFinding[] {
  const out: GrantFinding[] = [];
  for (const [chave, entry] of Object.entries(allowlist)) {
    if (entry.fechadaPor === null) {
      out.push({
        level: 'warn', codigo: 'FECHO_PENDENTE', tabela: chave, file: '(prod)',
        msg: `${chave}: fecho pendente (fechadaPor=null) — estado de prod não comparado ao contrato. ${entry.motivo}`,
      });
      continue;
    }
    const medTab = medido[chave] ?? {};
    for (const role of ROLES_VIGIADAS) {
      const permit = entry.permitido[role] ?? [];
      const tem = medTab[role] ?? [];
      const extra = tem.filter((p) => !permit.includes(p));
      if (extra.length === 0) continue;
      const pareceDefault = (['INSERT', 'UPDATE', 'DELETE'] as Priv[]).every((p) => extra.includes(p));
      out.push({
        level: 'error',
        codigo: pareceDefault ? 'NAO_APLICADA' : 'DRIFT_PROD',
        tabela: chave, file: '(prod)',
        msg: pareceDefault
          ? `${chave}: ${role} ainda tem ${extra.join(',')} — o fecho ${entry.fechadaPor} está no repo mas NÃO foi aplicado no SQL Editor (ou foi revertido).`
          : `${chave}: ${role} tem ${extra.join(',')} fora do permitido [${permit.join(',') || 'nenhum'}] — grant aplicado à mão em prod (drift).`,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Rodar — verde**

Run: `heavy bun run test scripts/authz-grants.test.ts > /tmp/t4b.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`; os 5 testes de `compararGrantsProd` passam junto com os anteriores.

- [ ] **Step 5: Typecheck + commit**

Run: `heavy bun run typecheck > /tmp/tc4.log 2>&1; echo "EXIT=$?"` → `EXIT=0`.

```bash
git add scripts/lib/authz-grants.ts scripts/authz-grants.test.ts
git commit -m "feat(authz): compararGrantsProd — núcleo puro do audit de prod [money-path]

Compara privilégios medidos em prod com o contrato. Distingue NAO_APLICADA (fecho no
repo mas authenticated ainda com o DML completo do default) de DRIFT_PROD (grant
parcial aplicado à mão). fechadaPor=null → FECHO_PENDENTE sem comparar.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Executável do audit de prod (`psql-ro`)

**Files:**
- Create: `db/audit-grants-tabelas-fechadas.ts`
- Modify: `package.json` (script `authz:grants:prod`)

**Interfaces:**
- Consumes: `AUTHZ_TABELAS_FECHADAS`, `compararGrantsProd`, `MedicaoProd`, `Priv`.
- Produces: executável — exit `0` limpo/pendente · `1` divergência · `2` erro de execução. Lê `PSQL_RO` (default `~/.config/afiacao/psql-ro`) e, se presente, `AUTHZ_GRANTS_TEST_JSON` (allowlist de teste, só para o harness PG17).

- [ ] **Step 1: Escrever o executável**

Create `db/audit-grants-tabelas-fechadas.ts`:

```ts
#!/usr/bin/env bun
/**
 * audit-grants-tabelas-fechadas.ts — AUDITORIA de prod (READ-ONLY via psql-ro) das tabelas
 * fechadas por privilégio. Complementa o gate estático (scripts/lib/authz-grants.ts, Parte C):
 * o estático pega a migration nova DENTRO do PR; este vê a verdade do BANCO (inclusive drift
 * aplicado à mão e migration nunca aplicada no SQL Editor). Não é CI (o CI não tem psql-ro).
 *
 * Uso:  bun run authz:grants:prod ; echo $?     (0=ok/pendente · 1=divergência · 2=erro)
 * Dente: db/test-audit-grants-tabelas-fechadas.sh (PG17 local, via AUTHZ_GRANTS_TEST_JSON).
 *
 * Vigia os 5 privilégios NÚCLEO (SELECT,INSERT,UPDATE,DELETE,TRUNCATE). MAINTAIN fica de fora:
 * has_table_privilege(...,'MAINTAIN') só existe no PG17 e prod pode ser anterior — o gate
 * estático (textual) é quem cobre MAINTAIN, sem risco de versão.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compararGrantsProd, type MedicaoProd } from '../scripts/lib/authz-grants';
import { AUTHZ_TABELAS_FECHADAS, type TabelaFechada, type Priv } from '../scripts/authz-tabelas-fechadas';

const PRIV_NUCLEO: Priv[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
const ROLES = ['anon', 'authenticated'] as const;
const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

function allowlist(): Record<string, TabelaFechada> {
  const raw = process.env.AUTHZ_GRANTS_TEST_JSON;
  return raw ? (JSON.parse(raw) as Record<string, TabelaFechada>) : AUTHZ_TABELAS_FECHADAS;
}

/** monta 1 query que devolve linhas "ROW|schema.name|role|priv|t|f" */
function montarQuery(chaves: string[]): string {
  const tabelas = chaves.map((c) => `'${c.split('.')[1].replace(/'/g, "''")}'`).join(',');
  const roles = ROLES.map((r) => `'${r}'`).join(',');
  const privs = PRIV_NUCLEO.map((p) => `'${p}'`).join(',');
  return `SELECT 'ROW|public.'||t||'|'||r||'|'||p||'|'||has_table_privilege(r,'public.'||t,p)
          FROM unnest(ARRAY[${tabelas}]) t, unnest(ARRAY[${roles}]) r, unnest(ARRAY[${privs}]) p;`;
}

function medir(al: Record<string, TabelaFechada>): MedicaoProd {
  const chaves = Object.keys(al);
  if (chaves.length === 0) return {};
  let raw: string;
  try {
    raw = execFileSync(PSQL, ['-tA', '-c', montarQuery(chaves)], { encoding: 'utf8' });
  } catch (e) {
    console.error(`❌ falha ao consultar prod via psql-ro (${PSQL}): ${(e as Error).message}`);
    process.exit(2);
  }
  const med: MedicaoProd = {};
  for (const ln of raw.split('\n')) {
    if (!ln.startsWith('ROW|')) continue; // ignora o eco 'SET' do psqlrc-ro
    const [, tabela, role, priv, tem] = ln.split('|');
    if (tem !== 't') continue;
    ((med[tabela] ??= {})[role as (typeof ROLES)[number]] ??= []).push(priv as Priv);
  }
  return med;
}

function main(): void {
  const al = allowlist();
  const findings = compararGrantsProd(medir(al), al);
  const erros = findings.filter((f) => f.level === 'error');
  const avisos = findings.filter((f) => f.level === 'warn');

  for (const a of avisos) console.log(`⚠️  [${a.codigo}] ${a.msg}`);
  for (const e of erros) console.error(`❌ [${e.codigo}] ${e.msg}`);

  if (erros.length > 0) {
    console.error(`\naudit-grants — ${erros.length} divergência(s) entre prod e o contrato (scripts/authz-tabelas-fechadas.ts).`);
    process.exit(1);
  }
  console.log(`✅ audit-grants — ${Object.keys(al).length} tabela(s) conferida(s); prod bate com o contrato${avisos.length ? ` (${avisos.length} pendente(s))` : ''}.`);
}

main();
```

- [ ] **Step 2: Adicionar o script de conveniência ao `package.json`**

Em `package.json`, na seção `"scripts"`, logo após a linha `"authz:check": ...`, adicione:

```json
    "authz:grants:prod": "bun db/audit-grants-tabelas-fechadas.ts",
```

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck > /tmp/tc5.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 4: Fumaça contra prod real (informativo, não bloqueia)**

Run: `bun run authz:grants:prod > /tmp/prod.log 2>&1; echo "EXIT=$?"; cat /tmp/prod.log`
Expected: como as duas nascem `fechadaPor=null`, saída = 2 avisos `[FECHO_PENDENTE]`, `EXIT=0`. (Se o `psql-ro` não estiver disponível nesta máquina, `EXIT=2` com a mensagem de falha — registre e siga; o dente real é o Task 6.)

- [ ] **Step 5: Commit**

```bash
git add db/audit-grants-tabelas-fechadas.ts package.json
git commit -m "feat(authz): audit de prod dos grants de tabela fechada (psql-ro) [money-path]

Mede has_table_privilege no banco real e compara com o contrato. Vê o que o gate
estático não vê: drift aplicado à mão e migration nunca aplicada no SQL Editor
(NAO_APLICADA). Vigia os 5 privilégios núcleo — MAINTAIN fica com o gate estático
(has_table_privilege de MAINTAIN só existe no PG17).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Teste de dente do audit de prod (PG17 local)

**Files:**
- Create: `db/test-audit-grants-tabelas-fechadas.sh`

**Interfaces:**
- Consumes: o executável `db/audit-grants-tabelas-fechadas.ts` via `PSQL_RO` (wrapper local) + `AUTHZ_GRANTS_TEST_JSON` (allowlist de teste). Não depende de prod nem do contrato real.

- [ ] **Step 1: Escrever o harness**

Create `db/test-audit-grants-tabelas-fechadas.sh`:

```bash
#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA O DENTE de db/audit-grants-tabelas-fechadas.ts (o audit de prod).        ║
# ║  Sobe PG17 local, cria uma tabela FECHADA conforme o contrato de teste, e roda  ║
# ║  o audit REAL apontando PSQL_RO para este PG. Depois FALSIFICA:                  ║
# ║   (A) fechada (só SELECT p/ authenticated) → audit limpo (exit 0);              ║
# ║   (B) GRANT INSERT a authenticated          → audit acusa (exit 1);             ║
# ║   (C) REVOKE INSERT (volta a fechar)        → acusação some (exit 0)  ← dente.  ║
# ║  A allowlist de teste entra por AUTHZ_GRANTS_TEST_JSON (não toca a real).        ║
# ║  Pré-req: brew install postgresql@17.  Rode: bash db/test-...sh ; echo $?       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"
SLUG="audit-grants"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
command -v bun >/dev/null || { echo "bun ausente no PATH"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

WRAP="$(mktemp "/tmp/psql-ro-fake.${SLUG}.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")"; rm -f "$WRAP"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

# wrapper que o audit chama como se fosse o psql-ro (repassa os args ao psql local)
cat > "$WRAP" <<WRAPEOF
#!/usr/bin/env bash
exec "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "\$@"
WRAPEOF
chmod +x "$WRAP"

# roles do Supabase + a tabela de teste
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.zz_fechada_test (id int primary key, v text);
ALTER TABLE public.zz_fechada_test ENABLE ROW LEVEL SECURITY;
-- estado FECHADO conforme o contrato: só SELECT p/ authenticated, nada p/ anon, escrita p/ service_role
REVOKE ALL ON TABLE public.zz_fechada_test FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.zz_fechada_test TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.zz_fechada_test TO service_role;
SQL

# allowlist de teste: uma tabela, âncora preenchida (para exercitar a comparação, não o pendente)
TEST_JSON='{"public.zz_fechada_test":{"fechadaPor":"20260101000000_x.sql","permitido":{"anon":[],"authenticated":["SELECT"]},"motivo":"teste"}}'

run_audit() { PSQL_RO="$WRAP" AUTHZ_GRANTS_TEST_JSON="$TEST_JSON" bun "$REPO_ROOT/db/audit-grants-tabelas-fechadas.ts" > /tmp/audit-out.$$ 2>&1; echo $?; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; cat /tmp/audit-out.$$ 2>/dev/null | sed 's/^/     /'; }

echo "── (A) estado fechado → audit limpo (exit 0) ──"
EC="$(run_audit)"
if [ "$EC" = 0 ]; then ok "A: exit 0 no estado fechado"; else bad "A: esperava exit 0, veio $EC"; fi

echo "── (B) reabertura (GRANT INSERT a authenticated) → audit acusa (exit 1, código no texto) ──"
P -q -c "GRANT INSERT ON TABLE public.zz_fechada_test TO authenticated;"
EC="$(run_audit)"
# casa CÓDIGO ASCII, caixa fixa, sem -i (lição #1483)
if [ "$EC" = 1 ] && command grep -q "DRIFT_PROD" /tmp/audit-out.$$; then
  ok "B: exit 1 e DRIFT_PROD presente"
else
  bad "B: esperava exit 1 + DRIFT_PROD, veio exit $EC"
fi

echo "── (C) FALSIFICAÇÃO: revoga o INSERT → acusação some (exit 0) ──"
P -q -c "REVOKE INSERT ON TABLE public.zz_fechada_test FROM authenticated;"
EC="$(run_audit)"
if [ "$EC" = 0 ]; then ok "C: exit 0 após revogar (dente reage à correção)"; else bad "C: esperava exit 0, veio $EC"; fi

echo "── (D) NAO_APLICADA: DML completo (default aberto) → código distinto ──"
P -q -c "GRANT INSERT,UPDATE,DELETE ON TABLE public.zz_fechada_test TO authenticated;"
EC="$(run_audit)"
if [ "$EC" = 1 ] && command grep -q "NAO_APLICADA" /tmp/audit-out.$$; then
  ok "D: exit 1 e NAO_APLICADA quando o DML completo está aberto"
else
  bad "D: esperava exit 1 + NAO_APLICADA, veio exit $EC"
fi
rm -f /tmp/audit-out.$$

echo "──────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = 0 ] || { echo "❌ VERMELHO"; exit 1; }
echo "✅ audit de prod com DENTE: detecta reabertura/drift, distingue NAO_APLICADA, reage à correção"
```

- [ ] **Step 2: Tornar executável e rodar**

Run: `chmod +x db/test-audit-grants-tabelas-fechadas.sh && bash db/test-audit-grants-tabelas-fechadas.sh > /tmp/dente.log 2>&1; echo "EXIT=$?"; cat /tmp/dente.log`
Expected: `EXIT=0`; log termina em `✅ audit de prod com DENTE…` com `4 ok / 0 fail`.

- [ ] **Step 3: Falsificar o próprio teste (provar que ele reprova)**

Temporariamente quebre o audit para confirmar que o dente morde. Edite `db/audit-grants-tabelas-fechadas.ts` e force `medir` a devolver `{}` (linha `const med: MedicaoProd = {};` → `return {};` logo após). Rode:

Run: `bash db/test-audit-grants-tabelas-fechadas.sh > /tmp/dente-sabotado.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=1` (cenários B e D falham — sem medição, nada é acusado). **Reverta a sabotagem** (`git checkout db/audit-grants-tabelas-fechadas.ts`) e confirme verde de novo:

Run: `git checkout db/audit-grants-tabelas-fechadas.ts && bash db/test-audit-grants-tabelas-fechadas.sh > /tmp/dente2.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 4: shellcheck (faz parte do /health)**

Run: `shellcheck db/test-audit-grants-tabelas-fechadas.sh > /tmp/sc.log 2>&1; echo "EXIT=$?"; cat /tmp/sc.log`
Expected: `EXIT=0` (sem avisos). Se houver, corrija (ex.: aspas em expansões).

- [ ] **Step 5: Commit**

```bash
git add db/test-audit-grants-tabelas-fechadas.sh
git commit -m "test(authz): dente PG17 do audit de prod de grants [money-path]

Sobe PG17, cria a tabela fechada conforme o contrato, roda o audit REAL via wrapper
PSQL_RO + allowlist de teste (AUTHZ_GRANTS_TEST_JSON). Prova detecção, distinção
NAO_APLICADA×DRIFT_PROD e reação à correção. Casa código ASCII sem -i, sob LC_ALL=C.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Resíduo durável (docs)

**Files:**
- Modify: `docs/agent/database.md` (nota curta na §7, apontando a sentinela)
- Create: `docs/historico/sentinela-grants-tabelas-fechadas.md` (diário da entrega)

**Interfaces:** nenhum código. Não engordar o CLAUDE.md (o CI vigia o tamanho — a lição vai para `docs/`).

- [ ] **Step 1: Ler o fim da §7 para achar o ponto de inserção**

Run: `sed -n '128,170p' docs/agent/database.md`
Expected: ver o conteúdo da §7 (hardening) e onde encaixar a nota.

- [ ] **Step 2: Acrescentar a nota na §7 de `docs/agent/database.md`**

Adicione, ao fim da §7 (ajuste o texto-âncora do Edit ao que o Step 1 mostrar), o parágrafo:

```markdown
- **Sentinela de grant de tabela fechada** (2026-07-22): tabela fechada por PRIVILÉGIO (REVOKE +
  GRANT SELECT + policy só de leitura, escrita só de service_role) reabre em SILÊNCIO se um GRANT
  futuro voltar. Vigiada por allowlist CURADA em `scripts/authz-tabelas-fechadas.ts` — **só** as
  tabelas listadas, nunca varredura em massa (o grant amplo do Supabase é o modelo da plataforma,
  §7 acima). Duas guardas compartilham a allowlist: o gate estático `auditGrantsTabelas`
  (`scripts/lib/authz-grants.ts`) roda como **Parte C do `authz:check`** (CI) e pega a migration
  que reabre DENTRO do PR; o audit `db/audit-grants-tabelas-fechadas.ts` (sob `psql-ro`,
  on-demand) vê o BANCO — inclusive drift à mão e migration nunca aplicada (`NAO_APLICADA`). Ancora
  no fecho (`fechadaPor`): só vigia o pós-âncora. Dente: `scripts/authz-grants.test.ts` +
  `db/test-audit-grants-tabelas-fechadas.sh`. Achados usam código ASCII (casar sem `-i`, #1483).
```

- [ ] **Step 3: Criar o diário da entrega**

Create `docs/historico/sentinela-grants-tabelas-fechadas.md`:

```markdown
# Sentinela de grants — tabelas deliberadamente fechadas (2026-07-22)

Origem: achado do review final da branch `authz-preco-fecha-omie-products`, fora do escopo daquela
entrega. Spec: `docs/superpowers/specs/2026-07-22-sentinela-grants-tabelas-fechadas-design.md`.

## Problema
`product_costs` (PR #1520) e `omie_products` fecham por PRIVILÉGIO (REVOKE + GRANT SELECT + policy),
não por policy. Um GRANT futuro reabre em silêncio — o `authz:check` cobria só gate em corpo de
função SECDEF, e os harnesses PG17 são manuais. Medido em prod (psql-ro, 2026-07-22): as duas ainda
ABERTAS — os fechos eram PRs draft nunca aplicados.

## Entrega
- `scripts/authz-tabelas-fechadas.ts` — allowlist curada (fonte única).
- `scripts/lib/authz-grants.ts` — `auditGrantsTabelas` (gate estático) + `compararGrantsProd` (audit), puros.
- Parte C do `authz:check` (CI) — reusa o step existente.
- `db/audit-grants-tabelas-fechadas.ts` — audit de prod on-demand (psql-ro).
- Dente: `scripts/authz-grants.test.ts` (vitest) + `db/test-audit-grants-tabelas-fechadas.sh` (PG17).

## Decisões
- Allowlist de privilégio (não denylist): privilégio novo — ex. `MAINTAIN` do PG17 — nasce barrado.
- Âncora `fechadaPor`: migrations só têm o delta; o estado absoluto não está no repo. Só vigia pós-âncora.
- `FECHO_PENDENTE` = warn (as duas nascem `null`): erro deixaria a `main` vermelha até os PRs mergearem.
- `ANCORA_NAO_DECLARADA`: o gate detecta o REVOKE sozinho — a transição pendente→vigiado é exigida
  pelo CI no PR do fecho, não confiada à memória de quem mantém.
- Refinamentos além da spec: `GRANT ... ALL TABLES IN SCHEMA` tratado como REABERTURA; audit
  distingue `NAO_APLICADA` de `DRIFT_PROD`; audit de prod vigia só os 5 privilégios núcleo
  (MAINTAIN quebra `has_table_privilege` em PG < 17 — fica com o gate estático).

## Como adotar quando o fecho for aplicado
Ao mergear o PR de fecho e aplicar a migration no SQL Editor: em `scripts/authz-tabelas-fechadas.ts`,
troque `fechadaPor: null` pelo nome do arquivo da migration. O gate estático passa a exigir isso
sozinho (`ANCORA_NAO_DECLARADA`) assim que o REVOKE entra no repo.
```

- [ ] **Step 4: Validar tamanho do CLAUDE.md (não foi tocado, mas o /health checa)**

Run: `bun run claude:size > /tmp/sz.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0` (não mexemos no CLAUDE.md; sanidade).

- [ ] **Step 5: Commit**

```bash
git add docs/agent/database.md docs/historico/sentinela-grants-tabelas-fechadas.md
git commit -m "docs(authz): registra a sentinela de grants na database.md §7 + diário [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verificação final (antes do PR)

- [ ] **Suíte + typecheck + lint + authz:check, todos verdes**

```bash
heavy bun run test > /tmp/final-test.log 2>&1; echo "TEST=$?"
heavy bun run typecheck > /tmp/final-tc.log 2>&1; echo "TC=$?"
bun lint > /tmp/final-lint.log 2>&1; echo "LINT=$?"
bun run authz:check > /tmp/final-ac.log 2>&1; echo "AC=$?"
```
Expected: `TEST=0 TC=0 LINT=0 AC=0`. Confirme no `final-ac.log` os 2 avisos `[FECHO_PENDENTE]`.

- [ ] **Re-conferir colisão multi-sessão imediatamente antes do PR** (regra do CLAUDE.md — a checagem do início vence numa sessão longa)

```bash
git fetch origin --quiet && git log origin/main --oneline -3 -- scripts/ db/ docs/agent/database.md
gh pr list --limit 20 --json number,headRefName,files --jq '.[] | select(.files[].path | test("authz|authz-grants|database.md")) | "\(.number) \(.headRefName)"'
```
Expected: nenhum PR paralelo tocando `scripts/authz-*`, `scripts/lib/authz-*`, `db/audit-grants-*` ou a §7 da `database.md`. Se houver, coordenar antes de abrir o PR.

- [ ] **Abrir o PR (não-draft → auto-merge quando o CI passar) e armar o watcher**

```bash
gh pr create --title "feat(authz): sentinela de grants de tabelas fechadas — gate CI + audit prod [money-path]" --body "$(cat <<'EOF'
## O quê
Vigia, por allowlist curada, que `product_costs` e `omie_products` (fechadas por privilégio) não sejam reabertas em silêncio.

- Gate estático `auditGrantsTabelas` como **Parte C do `authz:check`** (CI) — pega a migration que reabre dentro do PR.
- Audit de prod `db/audit-grants-tabelas-fechadas.ts` (psql-ro, on-demand) — vê o banco: drift à mão e `NAO_APLICADA`.
- Fonte única: `scripts/authz-tabelas-fechadas.ts`.

## Estado
As duas nascem `fechadaPor: null` (medido em prod: fechos ainda são PRs draft nunca aplicados) → 2 avisos `FECHO_PENDENTE`, exit 0. Quando os fechos mergearem, `ANCORA_NAO_DECLARADA` exige declarar a âncora.

## Dente
`scripts/authz-grants.test.ts` (vitest, 22 cenários) + `db/test-audit-grants-tabelas-fechadas.sh` (PG17, com falsificação). Achados casam código ASCII (lição #1483).

Spec: `docs/superpowers/specs/2026-07-22-sentinela-grants-tabelas-fechadas-design.md`
Plano: `docs/superpowers/plans/2026-07-22-sentinela-grants-tabelas-fechadas.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Depois: `scripts/pr-watch.sh <nº> &` (Bash `run_in_background:true`) e avisar no desfecho via PushNotification.

---

## Notas de execução

- **Ordem das tasks é sequencial** (2 depende de 1; 3 de 2; 4 de 2; 5 de 4; 6 de 5; 7 de tudo). Não paralelizar.
- **Limite conhecido do parser** (herdado do design, §5.2): a detecção de `ANCORA_NAO_DECLARADA` e de `GRANT_NAO_PARSEAVEL` é textual (regex sobre `stripNoise`). Uma forma exótica de `REVOKE`/`GRANT` que a regex não pegue faz o achado degradar para `FECHO_PENDENTE`/silêncio — falha para o lado do warn, **não** para o falso-verde perigoso. Os testes 12 e 13 do Task 2 cobrem as formas conhecidas; formas novas exigem estender `parseGrant`. Documentado de propósito, não é dívida oculta.
- Se `psql-ro` não existir nesta máquina, o Task 5 Step 4 sai `EXIT=2` (informativo) e o Task 6 exige `postgresql@17` (`brew install postgresql@17`). Nenhum dos dois bloqueia o CI — o gate estático (Tasks 1-3) é o que o `validate` roda.
