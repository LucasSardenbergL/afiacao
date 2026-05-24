# Runbook — Baseline do schema (pós-squash 2026-05-24)

O schema do repo foi consolidado num **baseline** (`supabase/migrations/20260524130000_baseline_schema_NAO_APLICAR_EM_PROD_EXISTENTE.sql`). As 222 migrations incrementais antigas estão em `db/archive/migrations_pre_baseline/` (preservadas, fora do replay). Detalhes do escopo: `db/BASELINE_MANIFEST.md`.

## ⛔ O que NUNCA fazer
- **Não aplicar o baseline em PRODUÇÃO existente.** Ele recria o schema do zero — em prod já existente, dá erro/estrago. Produção já tem o schema; não é tocada.
- **Não rodar `supabase db push` contra produção.** O histórico foi squashado: o remoto tem 222 versões aplicadas, o repo tem só o baseline → o CLI acusa divergência ("remote migration versions not found locally") ou tenta aplicar o baseline sobre schema existente. Se algum dia for usar o CLI contra prod, fazer `supabase migration repair` / marcar o baseline como já aplicado primeiro.

## Criar um ambiente novo (staging / disaster-recovery) a partir do baseline
1. Criar um projeto Supabase novo (ou banco vazio Supabase-compatível).
2. Habilitar as extensions de **plataforma** (dashboard): `pg_cron`, `pg_net`, `pg_stat_statements`, `supabase_vault`. (As 4 de DDL — `uuid-ossp`/`pgcrypto`/`pg_trgm`/`vector` — o baseline cria.)
3. Garantir `search_path` do banco incluindo `extensions` (default Supabase) — ver nota no manifest sobre `similarity()`.
4. Rodar o baseline (`...20260524130000_baseline_schema...sql`) no SQL Editor / via runner do projeto novo.
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

## audit:migrations (legado)
`bun run audit:migrations` agora retorna 0 custom migrations (o baseline é a fonte de verdade; o script exclui o baseline). Mantido por compat; sem função real pós-squash.
