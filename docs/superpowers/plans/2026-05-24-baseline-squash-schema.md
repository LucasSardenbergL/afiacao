# Baseline/squash do schema (Supabase-aware) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ⚠️ **RECONCILIADO 2026-05-24:** os PRs #244/#247 entregaram o **snapshot** na main em paralelo. Este plano foi parcialmente executado e **reconciliado**: o snapshot é da main; esta branch entregou só o **complemento funcional** (`supabase/schema-infra-outside-public.sql` + `schema-rebuild-runbook.md` + `schema-security-report.md`). **Tasks 7 (verificação local), 8 (archive das migrations) e o baseline em `supabase/migrations/` foram DESCARTADOS** (não mexer na pasta do Lovable). Plano mantido como registro.

**Goal:** Tornar o repo capaz de reconstruir um ambiente Supabase equivalente ao de produção a partir de um baseline único, substituindo as 222 migrations incrementais defasadas.

**Architecture:** Squash baseline Supabase-aware — `public` como núcleo (dump schema-only) + manifesto/runbook pro que vive fora de `public` (crons, buckets, realtime, extensions, nomes de secrets). Arquiva as 222 migrations fora de `supabase/migrations/`. Produção não é tocada.

**Tech Stack:** Supabase/Postgres, Lovable Cloud (chat + SQL Editor), supabase CLI 2.100.0 (local), postgres local via brew (verificação). Spec: `docs/superpowers/specs/2026-05-24-baseline-squash-schema-design.md`.

**Decisões já tomadas (resolvem questões abertas do spec):**
- **Q2 (verificação):** docker AUSENTE nesta máquina → `supabase start` indisponível. Substrato = **postgres local via brew + stubs** dos roles/auth/extensions. Prova sintaxe/ordem/dependência; comportamento runtime completo fica como limitação documentada (precisaria docker ou staging real).
- **Q5 (archive):** arquivar em `db/archive/migrations_pre_baseline/` (fora de `supabase/` inteiro → runner e scripts `find supabase/...` não pegam).
- **Q3 (audit:migrations):** aposentar o parser por-migration após o squash (o baseline vira a fonte de verdade); substituir por um audit que checa o baseline contra produção. Decisão final na Task 8.
- **Q1 (pg_dump via Lovable) e Q4 (Lovable lida com baseline+archive):** só resolvíveis com o founder — Tasks 1 e 9 (gates).

**Convenções de execução:** Tarefas marcadas **[FOUNDER]** exigem o founder rodar algo no Lovable (SQL Editor ou chat) e colar a saída; **[AGENTE]** o agente faz sozinho. Entregar todo SQL pro founder em blocos ```sql fechados com ``` em linha sozinha (CLAUDE.md §5). Responder em pt-BR.

---

## Task 1: [FOUNDER] Probe da capacidade de pg_dump no Lovable (Q1 — divisor de águas)

**Files:** nenhum (descoberta).

- [ ] **Step 1: Entregar o prompt pro chat do Lovable**

Pedir ao founder pra colar no **chat do Lovable** (não no SQL Editor):

> "Gere um dump SOMENTE DO SCHEMA (sem dados) do schema `public` do banco de produção, equivalente a `pg_dump --schema-only --schema=public --no-owner`, incluindo: tabelas, colunas, defaults, constraints, índices, sequences, tipos/enums, views (com `WITH (security_invoker=on)` quando aplicável), funções (com `SECURITY DEFINER` e `SET search_path` quando houver), triggers, policies RLS (e `ENABLE/FORCE ROW LEVEL SECURITY`), e os GRANT/REVOKE de EXECUTE em funções e de acesso a `anon`/`authenticated`/`service_role`. NÃO inclua dados, NÃO inclua `CREATE ROLE` de roles gerenciados, NÃO inclua `ALTER ... OWNER TO`. Me devolva o SQL completo num bloco de código."

- [ ] **Step 2: Avaliar o resultado**

Founder cola o que o Lovable devolveu (ou o erro). Decidir:
- **Sucesso** (SQL plausível e completo) → caminho primário; pular Task 2, ir pra Task 3 com esse dump.
- **Falha/parcial** (Lovable não consegue, ou devolve incompleto) → caminho fallback; ir pra Task 2 (introspecção).

- [ ] **Step 3: Registrar a decisão**

Anotar no PR/conversa qual caminho foi escolhido e por quê.

---

## Task 2: [FOUNDER] Fallback — extração por introspecção (só se Task 1 falhar)

**Files:** nenhum (descoberta); o agente monta o baseline a partir das saídas.

> Pular esta task inteira se a Task 1 deu sucesso.

- [ ] **Step 1: Inventário de objetos de `public` (ordem de dependência)**

```sql
-- tabelas (sem as de extensão), em ordem topológica aproximada por FK
SELECT c.relname, c.relkind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S')
ORDER BY c.relkind, c.relname;
```

- [ ] **Step 2: DDL de tabelas/constraints/índices**

Para cada tabela, coletar via `pg_get_constraintdef`, `pg_indexes`, e colunas via `information_schema.columns`. (O agente gera as queries específicas por tabela a partir do Step 1 e remonta os `CREATE TABLE`.)

- [ ] **Step 3: DDL de views, functions, triggers, policies**

```sql
SELECT 'VIEW '||table_name AS obj, pg_get_viewdef(('public.'||table_name)::regclass, true) FROM information_schema.views WHERE table_schema='public';
SELECT 'FUNC '||p.proname, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
SELECT * FROM pg_policies WHERE schemaname='public';
SELECT tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal;
```

- [ ] **Step 4: Agente remonta o baseline ordenado por dependência.** Resultado = mesmo artefato da Task 3.

---

## Task 3: [FOUNDER] Capturar objetos FORA de `public` (manifesto Supabase-aware)

**Files:** nenhum (descoberta).

- [ ] **Step 1: Extensions**

```sql
SELECT e.extname, n.nspname AS schema, e.extversion
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1;
```

- [ ] **Step 2: Crons (sem secrets)**

```sql
SELECT jobid, schedule, jobname, command FROM cron.job ORDER BY jobname;
```
(O agente vai trocar os secrets embutidos no `command` por placeholders ao montar o runbook.)

- [ ] **Step 3: Storage buckets**

```sql
SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY id;
```

- [ ] **Step 4: Realtime publications**

```sql
SELECT pubname, puballtables FROM pg_publication;
SELECT schemaname, tablename FROM pg_publication_tables ORDER BY 1,2;
```

- [ ] **Step 5: Nomes de secrets do vault (NUNCA valores)**

```sql
SELECT name FROM vault.secrets ORDER BY name;
```

---

## Task 4: [FOUNDER] Inventário pré-dump + freeze (Fase 0 do spec)

**Files:** nenhum (baseline de comparação pra Task 7).

- [ ] **Step 1: Pedir freeze informal**

Founder evita pedir mudanças de schema ao Lovable entre agora e o merge do PR (senão o baseline nasce defasado).

- [ ] **Step 2: Snapshot de contagens (guardar a saída)**

```sql
SELECT 'tabelas' k, count(*) v FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
UNION ALL SELECT 'views', count(*) FROM information_schema.views WHERE table_schema='public'
UNION ALL SELECT 'matviews', count(*) FROM pg_matviews WHERE schemaname='public'
UNION ALL SELECT 'functions', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
UNION ALL SELECT 'triggers', count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
UNION ALL SELECT 'policies', count(*) FROM pg_policies WHERE schemaname='public'
UNION ALL SELECT 'indexes', count(*) FROM pg_indexes WHERE schemaname='public'
UNION ALL SELECT 'enums', count(DISTINCT t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'
UNION ALL SELECT 'extensions', count(*) FROM pg_extension
UNION ALL SELECT 'crons', count(*) FROM cron.job
UNION ALL SELECT 'buckets', count(*) FROM storage.buckets
ORDER BY k;
```

Guardar a saída — é a referência da verificação (Task 7).

---

## Task 5: [AGENTE] Montar, escopar e sanitizar o baseline

**Files:**
- Create: `supabase/migrations/<ts>_baseline_schema_NAO_APLICAR_EM_PROD_EXISTENTE.sql`
- Create: `db/BASELINE_MANIFEST.md`

- [ ] **Step 1: Montar o núcleo `public`** a partir da Task 1 (ou 3 do fallback).

- [ ] **Step 2: Sanitizar.** Remover: `CREATE ROLE` de roles gerenciados; `ALTER ... OWNER TO`; `SET row_security`; ACLs a roles internos indevidos; comentários com dados sensíveis; qualquer `vault.decrypted_secrets` materializado. **Preservar:** GRANTs de hardening de EXECUTE, `WITH (security_invoker=on)`, RLS `ENABLE/FORCE`/policies.

- [ ] **Step 3: Prefixar extensions** (`CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA extensions`) a partir da Task 3 Step 1, preservando refs `extensions.*`.

- [ ] **Step 4: Adicionar crons/buckets/publications** (com secrets→placeholders) a partir da Task 3.

- [ ] **Step 5: Header explicativo** (gerado de produção em <data>; pra rebuild/staging, não pra prod existente).

- [ ] **Step 6: Escrever `db/BASELINE_MANIFEST.md`** — o que foi incluído, o que foi deliberadamente excluído, o que é gerenciado pelo Supabase.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/*_baseline_schema_*.sql db/BASELINE_MANIFEST.md
git commit -m "feat(db): baseline schema squash (núcleo public + manifesto Supabase-aware)"
```

---

## Task 6: [AGENTE] Security report (subproduto da sanitização)

**Files:**
- Create: `db/baseline-security-report.md`

- [ ] **Step 1: Varrer o baseline** por: funções `SECURITY DEFINER` sem `SET search_path = public, pg_temp`; views sem `security_invoker`; policies permissivas (`USING (true)`); funções com `EXECUTE` pra `PUBLIC`.

- [ ] **Step 2: Escrever o relatório** (só inventário, sem corrigir — vira follow-up).

- [ ] **Step 3: Commit**

```bash
git add db/baseline-security-report.md
git commit -m "docs(db): security report do baseline (SECURITY DEFINER/RLS/EXECUTE)"
```

---

## Task 7: [AGENTE] Verificar replay localmente (postgres via brew + stubs)

**Files:**
- Create: `db/verify-baseline.sh` (script de verificação reproduzível)

- [ ] **Step 1: Instalar postgres local**

Run: `brew install postgresql@16 && brew services start postgresql@16`
Expected: serviço up; `psql --version` funciona.

- [ ] **Step 2: Criar DB descartável + stubs Supabase**

```bash
createdb baseline_verify
psql baseline_verify -c "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;"
psql baseline_verify -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions; CREATE SCHEMA IF NOT EXISTS storage;"
psql baseline_verify -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULL::uuid \$\$; CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$\$ SELECT NULL::text \$\$;"
```

- [ ] **Step 3: Rodar o baseline e capturar erros**

Run: `psql baseline_verify --single-transaction -v ON_ERROR_STOP=1 -f supabase/migrations/*_baseline_schema_*.sql`
Expected: termina sem erro (replay sintático/ordem/dependência OK). Qualquer erro = corrigir o baseline (ordem/stub faltante) e repetir.

- [ ] **Step 4: Diff por catálogo (contagens)**

Rodar no DB local a MESMA query de contagens da Task 4 Step 2 e comparar com a saída de produção. Diferenças esperadas só nos itens fora-de-`public` que dependem do runtime Supabase; o resto deve bater. Documentar discrepâncias.

- [ ] **Step 5: Salvar o script + Commit**

```bash
git add db/verify-baseline.sh
git commit -m "test(db): script de verificação de replay do baseline (postgres local + stubs)"
```

- [ ] **Step 6: [FOUNDER] Diff por catálogo detalhado contra produção**

Entregar ao founder as queries de inventário detalhado (views via `pg_get_viewdef`+`reloptions`; functions via `prosecdef`+`proconfig`; `pg_policies`; grants via `role_table_grants`/`routine_privileges`; `relrowsecurity`/`relforcerowsecurity`) pra rodar em produção e comparar com o baseline. Confirmar paridade.

---

## Task 8: [AGENTE] Reestruturar o repo (archive + audit)

**Files:**
- Move: `supabase/migrations/*.sql` (as 222 antigas) → `db/archive/migrations_pre_baseline/`
- Modify/retire: `scripts/audit-custom-migrations.ts`

- [ ] **Step 1: Mover as 222 antigas**

```bash
mkdir -p db/archive/migrations_pre_baseline
git mv supabase/migrations/2026{0206..0524}*_*.sql db/archive/migrations_pre_baseline/ 2>/dev/null || \
  (for f in $(ls supabase/migrations/*.sql | grep -v baseline_schema); do git mv "$f" db/archive/migrations_pre_baseline/; done)
```
Confirmar que só o baseline (+ migrations pós-baseline, se houver) sobra em `supabase/migrations/`.

- [ ] **Step 2: Aposentar/adaptar `audit:migrations`**

Decisão (Q3): aposentar o parser por-migration. Substituir `scripts/audit-custom-migrations.ts` por um stub que aponta pro baseline como fonte de verdade, OU adaptá-lo pra parsear só o baseline. Atualizar `package.json` se necessário. Garantir que `bun run audit:migrations` não vire falso-verde.

- [ ] **Step 3: Atualizar CLAUDE.md §5** (workflow de migrations) refletindo o baseline + archive.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(db): arquiva 222 migrations pré-baseline e aposenta audit por-migration"
```

---

## Task 9: [FOUNDER] Teste real de compatibilidade com o Lovable (Q4 — gate pré-merge)

**Files:** nenhum (validação).

- [ ] **Step 1: Pedir ao Lovable uma migration trivial**

Com a branch `feat/baseline-squash-schema` (baseline + archive fora da pasta), pedir ao chat do Lovable pra gerar uma migration trivial (ex: um comentário numa coluna).

- [ ] **Step 2: Observar**

Confirmar que o Lovable: (a) NÃO mexe no baseline, (b) IGNORA `db/archive/`, (c) gera a nova migration normalmente em `supabase/migrations/`. Se quebrar/confundir → reavaliar a estrutura (ex: outra localização do archive) antes de mergear.

---

## Task 10: [AGENTE] PR + handoff

**Files:** nenhum.

- [ ] **Step 1: Validar local** (SQL-only não afeta tsc/eslint/test, mas rodar `bun run test` pra confirmar baseline verde).

- [ ] **Step 2: codex review** `--uncommitted` do diff acumulado.

- [ ] **Step 3: Push + PR** com: resumo, link pro spec, `BASELINE_MANIFEST.md`, security report, resultado da verificação (Task 7) e do teste Lovable (Task 9). Aviso: **não requer apply em prod** (é só do repo). `gh pr update-branch` + auto-merge.

- [ ] **Step 4: Escrever runbook** `docs/db/runbook-baseline.md` (Fase 6 do spec): criar staging do baseline; aplicar migration futura via SQL Editor; o que NUNCA rodar contra prod (`db push` com histórico squashado → divergência); como refrescar o baseline se houver drift de novo.

---

## Self-Review

**Spec coverage:** Fase 0 (Tasks 1,4) · Fase 1 extração (Tasks 1/2) · fora-de-public (Task 3) · Fase 2 sanitizar+manifesto+security report (Tasks 5,6) · Fase 3 verificação 3 níveis (Task 7: local + catálogo + diff founder) · Fase 4 restructure+PR (Tasks 8,10) · Fase 5 prod intacta (implícito; nenhuma task toca prod) · Fase 6 runbook (Task 10 Step 4). Q1/Q2/Q3/Q4/Q5 endereçadas. ✓

**Placeholders:** o conteúdo literal do baseline.sql não é escrito aqui porque é **gerado** pela extração (Task 1/2) — o plano dá o processo exato e os comandos, não um placeholder. Não há "TODO/implementar depois".

**Limitação conhecida:** verificação local (postgres+stubs) prova sintaxe/ordem/dependência, não comportamento runtime Supabase completo (sem docker). Verificação comportamental plena = follow-up se/quando docker ou staging real existir.
