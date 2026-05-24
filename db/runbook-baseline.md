# Runbook — Baseline do schema (pós-squash 2026-05-24)

Existe um **baseline** completo do schema de produção em **`db/baselines/2026-05-24_prod_schema_baseline.sql`** (+ tag git `schema-baseline-prod-2026-05-24`), pra reconstruir um ambiente Supabase do zero. **Decisão deliberada (pós-codex):** o baseline fica **fora** de `supabase/migrations/`, que continua **intocada** — porque o Lovable é dono operacional do backend e a pasta `supabase/migrations/` é reconhecida pelo ecossistema Lovable/Supabase (mexer nela arriscaria confundir o builder e o tracking `schema_migrations` do Supabase CLI). Detalhes do escopo: `db/BASELINE_MANIFEST.md`.

## ⛔ O que NUNCA fazer
- **Não aplicar o baseline em PRODUÇÃO existente.** Ele recria o schema do zero — em prod já existente, dá erro/estrago. Produção já tem o schema; não é tocada.
- **Não mover o baseline pra `supabase/migrations/`** nem arquivar as migrations de lá enquanto o Lovable for dono operacional do backend.
- **Não rodar `supabase db push` do baseline contra produção.** Ele tentaria recriar objetos sobre schema existente / causaria divergência no `schema_migrations`. `supabase migration repair` só mexe no tracking, não aplica SQL.

## Criar um ambiente novo (staging / disaster-recovery) a partir do baseline
1. Criar um projeto Supabase novo (ou banco vazio Supabase-compatível).
2. Habilitar as extensions de **plataforma** (dashboard): `pg_cron`, `pg_net`, `pg_stat_statements`, `supabase_vault`. (As 4 de DDL — `uuid-ossp`/`pgcrypto`/`pg_trgm`/`vector` — o baseline cria.)
3. Garantir `search_path` do banco incluindo `extensions` (default Supabase) — ver nota no manifest sobre `similarity()`.
4. Rodar o baseline (`db/baselines/2026-05-24_prod_schema_baseline.sql`) no SQL Editor / via runner do projeto novo.
5. Criar o secret **`CRON_SECRET`** no Vault do projeto novo.
6. Recriar os **33 crons** (ver §abaixo).
7. Conferir buckets (o baseline insere os 6) e a publication realtime (o baseline configura).

## Recriar os crons no ambiente novo
Os crons são env-specific (URL do projeto + secret no vault), por isso não vão no baseline. No projeto de ORIGEM, exportar as definições:
```sql
SELECT 'SELECT cron.schedule(' || quote_literal(jobname) || ', ' || quote_literal(schedule) || ', ' || quote_literal(command) || ');' AS stmt
FROM cron.job ORDER BY jobname;
```
Depois, no projeto NOVO: substituir `https://<PROJECT_REF_ANTIGO>.supabase.co` pela URL do projeto novo, e o JWT anon hardcoded do cron `sayerlack-portal-watchdog` pelo anon key do projeto novo (ver security report). Colar no SQL Editor do projeto novo. Inventário dos 33 jobs + schedules: `db/BASELINE_MANIFEST.md`.

## Se o Lovable criar drift de novo (refrescar o baseline)
1. Pedir ao chat do Lovable um novo `pg_dump --schema-only --schema=public --no-owner` (mesmo prompt da geração original).
2. Salvar em `db/_incoming/production_schema_dump.sql` (gitignored).
3. Re-rodar `bash db/build-baseline.sh` (re-gera o baseline com os mesmos transforms).
4. Re-capturar fora-de-`public` (extensions/crons/buckets/publication) e atualizar o manifest se mudou.
5. Verificar (codex / staging) → commitar → PR.

## audit:migrations
Inalterado — `supabase/migrations/` segue intocada, então `bun run audit:migrations` continua funcionando normalmente sobre as migrations custom de lá. O baseline (em `db/baselines/`) não é uma migration e não entra nesse audit.
