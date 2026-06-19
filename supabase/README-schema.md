# Snapshot de schema — `schema-snapshot.sql`

> Gerado em **2026-06-19** (anterior: 2026-05-24) a partir do banco de produção (Supabase do Lovable, projeto `fzvklzpomgnyikkfkzai`, PostgreSQL 17.6) via `pg_dump --schema-only --schema=public --no-owner --no-privileges`. ⚠️ Esta geração é **public-only** e referencia o schema `private` sem dumpá-lo (ver §Armadilhas e o manifest) — a **próxima** regeneração inclui `--schema=private`.

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

> A captura **funcional completa** da infra fora de `public` está **entregue** ao lado deste arquivo: **`schema-infra-outside-public.sql`** (buckets + realtime publication, idempotente), **`schema-rebuild-runbook.md`** (ordem de rebuild, recriação dos 33 crons, verificação) e **`schema-security-report.md`**. (O *archive* das migrations foi **descartado** de propósito — decisão pós-codex: não mexer em `supabase/migrations/` enquanto o Lovable é dono operacional do backend.)

## Como restaurar (em projeto Supabase, não Postgres puro)

⚠️ O snapshot referencia `auth.uid()` (1119×), `auth.role()`, `auth.users` nas policies. Só restaura num **projeto Supabase** (que provê o schema `auth`). Em Postgres puro seria necessário stubar `auth.*` (ver `schema-rebuild-runbook.md` §Verificação).

1. Rode **`schema-extensions-prelude.sql`** primeiro (cria schema `extensions` + uuid-ossp/pgcrypto/pg_trgm e `vector` em `public`; `pg_cron` fica comentado — ver abaixo).
2. Rode **`schema-snapshot.sql`** com **`psql`** (é dump SQL plain; **não** use `pg_restore`, que serve só pra formatos custom/tar/directory).

### Armadilhas conhecidas
- O dump tem **`CREATE SCHEMA public;`** sem `IF NOT EXISTS` (linha ~27). Num projeto novo o schema `public` já existe → o statement falha. **Remova essa linha** (caminho preferido); só tolere o erro se rodar **sem** `ON_ERROR_STOP` (com `ON_ERROR_STOP` o restore aborta aí).
- O dump é do **pg_dump 17** e usa os meta-comandos `\restrict` / `\unrestrict` (primeira/última linha), reconhecidos pelo `psql`. O SQL Editor do Lovable pode não reconhecê-los — remova-os se restaurar por lá.
- O prelude deixa **`pg_cron` comentado** de propósito (habilitá-lo pode abortar o restore sob `ON_ERROR_STOP`). Habilite-o antes pelo dashboard do Supabase se quiser as views `v_cron_jobs_status` / `v_cron_jobs_falhas`; senão elas falham no replay e devem ser puladas.
- ⚠️ **Schema `private` (desde 2026-05-27, migration `20260527160000`).** Este dump public-only **referencia mas NÃO cria** `private.mv_sku_ranking_negociacao_paralela` — 3 objetos do `public` dependem dela (funções `get_sku_ranking_negociacao_paralela` / `refresh_sku_ranking_negociacao` + view `v_sugestao_negociacao_ativa`) → restore/replay aborta com `schema "private" does not exist`. Crie `private` antes (rode `20260527160000`) **ou** regenere com `--schema=private` (prompt §"Como re-gerar" já atualizado).

> **Status do replay.** A validação limpa de **2026-05-24** vale só para AQUELA geração (public-only; contagens 212/37/4/86/76/14/474). ⚠️ A geração de **2026-06-19** (35.367 linhas) **NÃO passa ainda** no `db/verify-snapshot-replay.sh`: o dump public-only referencia `private.mv_sku_ranking_negociacao_paralela` (matview movida `public`→`private` pela migration `20260527160000`) sem dumpá-la → `ERROR: schema "private" does not exist`. **Fix:** regenerar com `--schema=private` (prompt abaixo já atualizado) e re-rodar. O harness roda prelude + stubs (`db/stubs-supabase.sql`) num Postgres 17 descartável (transação única, `ON_ERROR_STOP`) e prova ordem/dependência/sintaxe + RLS amostrada do `public`; **não** prova o runtime Supabase real (RLS/`auth`) — o "Gold" pede projeto Supabase vazio ou docker (ver `schema-rebuild-runbook.md` §Verificação).

## Como re-gerar

Cole no **chat do Lovable** (não no SQL Editor):

> Gere um dump SQL literal dos schemas `public` e `private` deste banco Supabase usando pg_dump, com flags equivalentes a `pg_dump --schema-only --schema=public --schema=private --no-owner --no-privileges`. Não inclua dados nem os schemas auth/storage/realtime/vault/extensions/cron/graphql/pgsodium/supabase_functions. Não resuma nem trunque. Entregue o conteúdo INTEGRAL como arquivo `supabase/schema-snapshot.sql` e faça commit. Confirme o número de linhas.

Depois atualize **`schema-snapshot.manifest.md`** com as novas contagens — o diff do git é a revisão do drift.

## Cadência

Artefato periódico, não sincronização contínua. Re-gerar: após qualquer módulo/tabela/RPC nova criada pelo Lovable, antes de criar staging ou migrar projeto, no mínimo mensalmente se o banco muda, ou sob demanda quando suspeitar de drift.
