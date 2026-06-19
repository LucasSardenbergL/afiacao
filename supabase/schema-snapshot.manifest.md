# Manifest — `schema-snapshot.sql`

> Contagens do snapshot. Ao re-gerar o dump, atualize esta tabela: o **diff do git é a revisão do drift** de schema entre uma geração e a próxima.

| Campo | Valor |
|---|---|
| Gerado em | 2026-06-19 |
| Fonte | produção (Supabase Lovable, `fzvklzpomgnyikkfkzai`) — regen via `~/.config/afiacao/psql-ro` (`claude_ro`, read-only, pooler eu-west-1); **escopo-equivalente** ao dump do Lovable (mesmos flags), validado por composição + remoções confirmadas em prod |
| Versão do banco | PostgreSQL 17.6 |
| pg_dump | 17.10 |
| Flags | `--schema-only --schema=public --no-owner --no-privileges` |
| Linhas do arquivo | 35.366 |
| Tamanho | ~1,3 MB |

> **Geração anterior (2026-05-24, pg_dump 17.9, 23.745 linhas) estava gravemente stale:** faltavam ~60 tabelas, ~124 funções, ~105 policies criadas por migrations posteriores. As ~16 policies + 1 matview que "sumiram" nesta geração são **remoções reais** em prod (o hardening de RLS substituiu as policies amplas `"Staff can manage …"` pelas granulares por carteira; matview `mv_sku_ranking_negociacao_paralela` dropada) — confirmado via psql-ro.

## Contagens por tipo (schema `public`)

| Objeto | Quantidade |
|---|---:|
| `CREATE TABLE` | 272 |
| `CREATE VIEW` | 53 |
| `CREATE MATERIALIZED VIEW` | 3 |
| `CREATE FUNCTION` | 210 |
| `CREATE TRIGGER` | 91 |
| `CREATE TYPE` | 14 |
| `CREATE POLICY` | 579 |
| `ENABLE ROW LEVEL SECURITY` | 269 |
| views com `security_invoker` | 52 |

## Extensions referenciadas pelo `public` (ver `schema-extensions-prelude.sql`)

| Extension | Schema | Uso no snapshot |
|---|---|---|
| uuid-ossp | extensions | `extensions.uuid_generate_v4()` |
| pgcrypto | extensions | `extensions.gen_random_bytes()` |
| pg_trgm | extensions | `extensions.gin_trgm_ops` |
| vector | public | `public.vector(1536)`, `public.vector_cosine_ops` |
| pg_cron | cron | views `v_cron_jobs_*` leem `cron.job` |
