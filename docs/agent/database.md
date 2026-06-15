# Banco de dados — referência operacional (Afiação/Colacor)

> Lições duráveis de banco. Carregado sob demanda (não fica no `CLAUDE.md`). Narrativa histórica de cada PR em `docs/historico/`. Para mudança de banco use a skill `lovable-db-operator`; para provar SQL money-path use `prove-sql-money-path`; para diagnosticar sync/cron use `diagnose-supabase-sync`.

- **Project ref Supabase:** `fzvklzpomgnyikkfkzai` (região `eu-west-1`, pooler `aws-1`). Project URL: `https://fzvklzpomgnyikkfkzai.supabase.co`. NÃO confundir com `lkotrsfdvnwxqyevhffh` (projeto-teste vazio).

## 1. Acesso ao banco

### Leitura/diagnóstico — DIRETO via `psql-ro` (desde 2026-06-14)
Há um usuário **read-only** no Postgres de produção (`claude_ro`) acessível por um wrapper local:

```bash
~/.config/afiacao/psql-ro -c "SELECT ..."     # blindado: SESSION READ ONLY + statement_timeout 30s
```

- **Eu rodo leitura/diagnóstico sozinho** — sem o founder colar no SQL Editor. Conferir migration aplicada, frescor de dado, audit, `pg_get_functiondef`, `net._http_response`, debugar incidente de sync.
- **É read-only de verdade:** o wrapper força `SESSION READ ONLY` (via `psqlrc`), que barra escrita **até via RPC `SECURITY DEFINER`** (`cannot execute UPDATE in a read-only transaction`). A credencial vive em `~/.config/afiacao/` (perm 600, **fora do repo** — nunca commitada).
- **`BYPASSRLS`:** o `claude_ro` lê todos os dados (inclusive sensíveis). É read-only, então zero risco de integridade. Desligar: `DROP ROLE claude_ro;` (founder decide). O pooler ignora `PGOPTIONS` — por isso o read-only vem via `psqlrc`, não startup param.
- **Como foi montado:** o Lovable NÃO expõe a connection string, mas dá pra montar (ref + user `claude_ro.<ref>` + senha definida no `CREATE ROLE` + região do pooler **descoberta por brute-force**: `aws-1-eu-west-1`). A conexão direta `db.<ref>.supabase.co` NÃO existe (projetos novos só têm o pooler Supavisor).

### Escrita — SOMENTE via SQL Editor do Lovable
O founder NÃO tem terminal/psql/CLI **de escrita** pro backend. Toda DDL/DML/migration é colada no **SQL Editor do Lovable** → Run. Eu nunca aplico escrita; preparo o material (via `lovable-db-operator`) e o founder cola. Formatar blocos SQL: fenced ` ```sql `, terminando com ` ``` ` numa linha sozinha (o app renderiza o botão Copy), rótulo `🟣 Lovable → SQL Editor → cola → Run`.

## 2. Migrations — Lovable NÃO auto-aplica (a armadilha-mãe)

- **Lovable Cloud NÃO aplica migration de nome custom** (`YYYYMMDDHHMMSS_slug.sql`) commitada em `supabase/migrations/`. Mergear o PR deixa o código no repo, mas o **banco continua sem o objeto** — falha SILENCIOSA (a feature compila, referencia tabela inexistente, quebra em prod). Só migration de nome UUID (builder visual) roda sozinha.
- **Toda migration custom exige:** (1) o `.sql` idempotente, (2) o bloco pro SQL Editor, (3) uma **query de validação** read-only pós-apply, (4) nota no PR "⚠️ migration manual", (5) `bun run audit:migrations` + commit dos artefatos. A skill `lovable-db-operator` empacota isso.
- Auditoria de quais migrations estão aplicadas: `scripts/audit-custom-migrations.sql` (cola no SQL Editor) + `docs/migrations-audit.md` (regenera com `bun run audit:migrations`).
- ⚠️ **Multi-sessão:** timestamps de migration colidem entre worktrees paralelas. É inócuo porque a aplicação é manual (não por ordem de timestamp), mas garanta que o seu ordena depois do último. **Quando 2 migrations recriam a MESMA função, a última a rodar vence** — garanta a ordem OU re-aplique a vencedora por último.

## 3. Schema não-rebuildável + snapshot

As migrations em `supabase/migrations/` **NÃO são uma cadeia restaurável** — ~210 objetos existem em prod sem `CREATE` commitado (módulos criados direto no Lovable; migrations seguintes só `ALTER`am tabelas-fantasma). Um `db reset` quebra.
- **Fonte de DR/auditoria:** `supabase/schema-snapshot.sql` (`pg_dump` schema-only de prod, gerado pelo chat do Lovable). Ler `supabase/README-schema.md` antes de restaurar.
- **Validação de restore:** `db/verify-snapshot-replay.sh` (Postgres 17 local + stubs) — prova ordem/dependência/sintaxe + RLS amostrado.
- ⚠️ **NUNCA mexer em `supabase/migrations/`** (não mover snapshot pra lá, não arquivar) — a pasta é reconhecida pelo ecossistema Lovable.

## 4. RLS (padrões)

- Helpers: `pode_ver_carteira_completa(uid)` (master OU gestor comercial), `carteira_visivel_para(customer)` (carteira + cobertura). `service_role` bypassa (engines).
- **Hardening de tabela exposta:** `FOR ALL` amplo (`master OR employee`) é BFLA — qualquer staff gerencia tudo via PostgREST. Padrão: split do `FOR ALL` → SELECT (gestor/master OR own OR carteira) + IUD (gestor/master OR own). Assimetria leitura>escrita: cobertura lê, não muta.
- Tabela nova **sempre** sai com RLS (CLAUDE.md §11). Catálogo de policies no estilo do repo: `references/sql-house-style.md` da skill `lovable-db-operator`.

## 5. Armadilhas caras (todas mordidas em prod)

- **PostgREST quebra `.or()` em UPDATE/PATCH** com `42703` (`column does not exist`) **mesmo a coluna existindo** — o banco puro aceita, só a camada REST quebra; `NOTIFY pgrst reload` não resolve. Diagnóstico: `BEGIN;UPDATE;ROLLBACK` no SQL Editor distingue banco × PostgREST. Fix: **RPC SQL-pura com predicado POSITIVO explícito** (não a tradução do `.or()`).
- **`.not(col,'ilike',v)` / qualquer negação é NULL-blind** — exclui silenciosamente linhas com a coluna NULL. Para negação tolerante a NULL: `.or('col.is.null,and(col.not.<op>.val,...)')` via função pura (não template no `.or()` cru — a regra ESLint `no-restricted-syntax` barra).
- **`CREATE OR REPLACE VIEW` só ACRESCENTA coluna no fim** (não reordena) → `cannot change name of view column`. **Sempre `pg_get_viewdef` da prod antes** de um REPLACE de view e case a ordem exata.
- **Função plpgsql com SQL inválido PASSA no `CREATE`** (late-bound) e só falha ao **EXECUTAR** — atrás de cron/`try-catch` best-effort, falha SILENCIOSA por dias. Prove com `prove-sql-money-path` (PG17 que EXECUTA a função, não só cria).
- **`CREATE OR REPLACE` manual de função exige pré-flight `pg_get_functiondef`** da prod (o repo pode divergir de prod no apply manual — drift). Hoje dá pra fazer direto via `psql-ro`.
- **`REVOKE ... FROM PUBLIC` NÃO tira `anon`/`authenticated` no Supabase** — eles têm grant EXPLÍCITO via default privileges. Revogar por nome (`REVOKE ... FROM anon, authenticated, PUBLIC`). Mas `service_role` recebe EXECUTE por default privileges (checar `has_function_privilege` antes de assumir bloqueio).
- **Sinal money-path NUNCA em coluna jsonb compartilhada por múltiplos writers** — `upsert` é last-writer-wins **destrutivo** no jsonb (sobrescreve o objeto inteiro). Use **coluna dedicada** (cada writer só toca se incluir no payload) + 1 writer autoritativo. Diagnóstico: `metadata ? 'chave'` (operador de existência) distingue "writer omitiu" de "fonte mandou null".
- **`inventory_position.account` tem 2 convenções:** `omie-analytics-sync` grava `vendas`/`colacor_vendas`/`servicos` (Omie account); `sync-reprocess` grava `oben`/`colacor` (empresa). Unique por `(omie_codigo_produto, account)` → somar por empresa exige eleger a canônica e excluir a crua (senão double-count).
- **`omie_products.account` é convenção EMPRESA** (`oben`/`colacor`/`colacor_sc`), ≠ `inventory_position`. JOIN account-blind em RPC money-path duplica silenciosamente (sem UNIQUE no item).
- **Vocabulário de status de título é NATIVO do Omie** (`'A VENCER'`/`'ATRASADO'`/`'VENCE HOJE'`), não `'ABERTO'`/`'VENCIDO'` — usar `OPEN_TITLE_STATUSES` de `src/lib/financeiro/titulo-status.ts`.
- **`bun run <cmd> | tail` ENGOLE o exit code** (o pipe retorna o status do `tail`) → teste/typecheck que FALHA passa batido. Quando o exit importa: `> log 2>&1; echo $?`.

## 6. Edge functions — deploy via chat do Lovable

Edge functions são criadas/editadas pelo **chat do Lovable** (não pela UI Cloud, que é só logs). Para função grande/edit: instruir o chat a ler `supabase/functions/<nome>/index.ts` do repo e deployar **verbatim** (o Lovable tende a "melhorar" — proibir). Deploy SÓ depois do merge (senão lê a main velha). Verificar por comportamento, não pela palavra do Lovable.
