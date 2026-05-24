# Snapshot de schema — `schema-snapshot.sql`

> Gerado em **2026-05-24** a partir do banco de produção (Supabase do Lovable, projeto `fzvklzpomgnyikkfkzai`, PostgreSQL 17.6) via `pg_dump --schema-only --schema=public --no-owner --no-privileges`.

## O que é

`schema-snapshot.sql` é um retrato **schema-only** (sem dados) do schema `public` de produção. É um **artefato de referência, DR e auditoria** — não um sistema de migrations.

## Por que existe (leia antes de confiar nas migrations)

As migrations em `supabase/migrations/` **NÃO são uma cadeia restaurável**. Há drift sistêmico: o Lovable cria muitos objetos direto em produção e não commita o `CREATE`. Diagnóstico de 2026-05-24 (set-difference catálogo de produção × `CREATE`s das migrations):

| Tipo | Em produção | Sem `CREATE` no repo |
|---|---:|---:|
| Tabelas | 212 | ~60 |
| Funções | 86 | ~41 |
| Views | 37 | 25 |
| Triggers | 76 | ~22 |
| Enums | 14 | 5 |
| Materialized views | 4 | 1 |
| Policies (RLS) | 474 | ~56 |

Um `supabase db reset` a partir das migrations **quebra** (ex: `20260510235956` faz `ALTER VIEW` em views que nenhuma migration cria; `sku_parametros` é ALTERada em 20 migrations mas nunca criada). Produção é a fonte da verdade e funciona; este snapshot é a forma versionada e auditável desse estado.

## O que está coberto / o que NÃO está

**Coberto** (schema `public`): tabelas, colunas, defaults, constraints, índices, sequences, tipos/enums, views (com `security_invoker`), materialized views, funções, triggers, RLS (`ENABLE` + policies).

**NÃO coberto** (schema-only de `public`):
- Dados, valores de sequences, registros.
- Usuários **Auth**, objetos do **Storage**, **secrets do Vault**, **Edge Functions**.
- Infra fora de `public`: **crons** (`cron.job`), **buckets** (`storage.buckets`), **realtime publications**, **extensions** (ver prelude).

> A captura **funcional completa** (infra fora de `public` + archive das migrations + verificação de replay + runbook) está planejada como baseline-squash na branch **`feat/baseline-squash-schema`** — executar quando houver necessidade real de staging/DR funcional.

## Como restaurar (em projeto Supabase, não Postgres puro)

⚠️ O snapshot referencia `auth.uid()` (1119×), `auth.role()`, `auth.users` nas policies. Só restaura num **projeto Supabase** (que provê o schema `auth`). Em Postgres puro seria necessário stubar `auth.*` (ver branch `feat/baseline-squash-schema`).

1. Rode **`schema-extensions-prelude.sql`** primeiro (cria schema `extensions` + uuid-ossp/pgcrypto/pg_trgm, `vector` em `public`, `pg_cron`).
2. Rode **`schema-snapshot.sql`**.

### Armadilhas conhecidas
- O dump tem **`CREATE SCHEMA public;`** sem `IF NOT EXISTS` (linha ~27). Num projeto novo o schema `public` já existe → o statement falha. Remova essa linha ou rode tolerando o erro.
- O dump é do **pg_dump 17** e usa os meta-comandos `\restrict` / `\unrestrict` (primeira/última linha). Funcionam via `psql`/`pg_restore`; o SQL Editor do Lovable pode não reconhecê-los — remova-os se restaurar por lá.
- Se `pg_cron` não puder ser habilitado, as views `v_cron_jobs_status` / `v_cron_jobs_falhas` falham no replay e podem ser puladas.

> **Status: restore NUNCA foi testado.** Sem um teste de restore num projeto Supabase vazio, este arquivo é **inventário, não seguro de recuperação**. Validar o restore é follow-up (ver branch `feat/baseline-squash-schema`).

## Como re-gerar

Cole no **chat do Lovable** (não no SQL Editor):

> Gere um dump SQL literal do schema public deste banco Supabase usando pg_dump, com flags equivalentes a `pg_dump --schema-only --schema=public --no-owner --no-privileges`. Não inclua dados nem os schemas auth/storage/realtime/vault/extensions/cron/graphql/pgsodium/supabase_functions. Não resuma nem trunque. Entregue o conteúdo INTEGRAL como arquivo `supabase/schema-snapshot.sql` e faça commit. Confirme o número de linhas.

Depois atualize **`schema-snapshot.manifest.md`** com as novas contagens — o diff do git é a revisão do drift.

## Cadência

Artefato periódico, não sincronização contínua. Re-gerar: após qualquer módulo/tabela/RPC nova criada pelo Lovable, antes de criar staging ou migrar projeto, no mínimo mensalmente se o banco muda, ou sob demanda quando suspeitar de drift.
