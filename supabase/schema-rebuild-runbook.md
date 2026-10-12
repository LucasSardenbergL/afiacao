# Runbook — rebuild funcional a partir do snapshot de schema

Complemento do **`supabase/schema-snapshot.sql`** (#244/#247), que é o retrato `--schema=public` de produção mas **não cobre a infra fora de `public`** nem ensina o rebuild funcional. Este runbook + `supabase/schema-infra-outside-public.sql` + `supabase/schema-security-report.md` fecham essa lacuna (a "captura funcional completa" que o `README-schema.md` deferiu).

> ⚠️ Produção NÃO é tocada por nada aqui. Isto é só pra reconstruir um ambiente **novo** (staging/DR/onboarding).

## ⛔ O que NUNCA fazer
- **Não mover o snapshot pra `supabase/migrations/`** nem arquivar as migrations de lá — o Lovable é dono operacional do backend e a pasta é reconhecida pelo ecossistema Lovable/Supabase (decisão pós-codex; risco de confundir builder + tracking `schema_migrations`).
- **Não aplicar o snapshot em produção existente** nem rodar `supabase db push` dele contra prod (recriaria objetos / divergiria o tracking).

## Ordem do rebuild (num projeto Supabase NOVO e vazio)
1. **Prelude:** `supabase/schema-extensions-prelude.sql` (extensions de DDL: uuid-ossp/pgcrypto/pg_trgm em `extensions`, `vector` em `public`; `pg_cron` fica a habilitar pelo dashboard).
2. **Schema:** `supabase/schema-snapshot.sql` via `psql` (ver armadilhas no `README-schema.md`: remover `CREATE SCHEMA public;` sem IF NOT EXISTS, remover `\restrict`/`\unrestrict`; não usar `pg_restore`).
3. **Infra fora de `public`:** `supabase/schema-infra-outside-public.sql` (buckets + realtime publication — idempotente).
4. **Vault:** criar o secret **`CRON_SECRET`** no Vault do projeto novo (NUNCA o valor real no repo).
5. **Crons:** recriar (ver §abaixo).
6. **Plataforma (dashboard):** habilitar `pg_cron`, `pg_net`, `pg_stat_statements`, `supabase_vault` se ainda não estiverem.

## Recriar os crons (env-specific)
A fonte é **`supabase/cron-jobs-snapshot.tsv`**: o `cron.job` de prod capturado pelo `bash db/refresh-snapshot.sh`
(ou só ele, em segundos: `--so-cron`). Uma linha por job (jobname, schedule, active, username, database, command
com `\n`/`\t`/`\\` escapados). O CI (`scripts/cron-jobs-snapshot-gate.test.ts`) barra captura truncada,
segredo literal no command e job de prod que nenhuma migration recria. O inventário estático de 33 crons que
vivia aqui (2026-05-24) foi aposentado no M-37 — prod tinha 99 em 2026-10-11.

No projeto NOVO: gerar um `cron.schedule` por linha ativa do TSV (desescapando o command), trocar
`https://<REF_ANTIGO>.supabase.co` pela URL nova e conferir que os secrets do Vault (`CRON_SECRET` etc.)
existem — o snapshot não carrega segredo, só a referência ao vault. Colar no SQL Editor.

## Verificação de replay
**Replay sintático/ordem validado em 2026-05-24** via `db/verify-snapshot-replay.sh` (Postgres 17 local + `db/stubs-supabase.sql`): prelude + stubs + snapshot em transação única (`ON_ERROR_STOP`) rodaram limpo e as contagens batem 1:1 com produção (212/37/4/86/76/14/474). Níveis:
- **Gold (pendente):** rodar a sequência num projeto Supabase vazio (provê `auth`/roles/extensions reais). Sem docker nesta máquina pra `supabase start`.
- **Sintaxe/ordem (FEITO):** `db/verify-snapshot-replay.sh` — Postgres + stub de roles (`anon`/`authenticated`/`service_role`) + schema `auth` (`auth.uid()`/`auth.role()`) + extensions. Prova ordem/dependência do `public`, não o comportamento de plataforma. ⚠️ O script contorna percalços do brew keg-only (popula share/lib do postgresql@17 a partir do Cellar; módulos `.dylib`; `LC_ALL=C` senão o postmaster aborta).
- Garantir `search_path` do banco incluindo `extensions` (default Supabase) — funções com `similarity()` não-qualificado dependem disso (ver security report).

## Se o Lovable criar drift de novo
Re-gerar o `schema-snapshot.sql` pelo prompt do `README-schema.md`, atualizar o manifest (o diff do git é a revisão do drift), e re-conferir a infra fora de `public` (rodar as queries de captura do design em `docs/superpowers/specs/2026-05-24-baseline-squash-schema-design.md`).
