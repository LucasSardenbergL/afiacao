# Manifest — `schema-snapshot.sql`

> Contagens do snapshot. Ao re-gerar o dump, atualize esta tabela: o **diff do git é a revisão do drift** de schema entre uma geração e a próxima.

| Campo | Valor |
|---|---|
| Gerado em | 2026-05-24 |
| Fonte | produção (Supabase Lovable, `fzvklzpomgnyikkfkzai`) |
| Versão do banco | PostgreSQL 17.6 |
| pg_dump | 17.9 |
| Flags | `--schema-only --schema=public --no-owner --no-privileges` |
| Linhas do arquivo | 23.745 |
| Tamanho | ~838 KB |

## Contagens por tipo (schema `public`)

| Objeto | Quantidade |
|---|---:|
| `CREATE TABLE` | 212 |
| `CREATE VIEW` | 37 |
| `CREATE MATERIALIZED VIEW` | 4 |
| `CREATE FUNCTION` | 86 |
| `CREATE TRIGGER` | 76 |
| `CREATE TYPE` | 14 |
| `CREATE POLICY` | 474 |
| `ENABLE ROW LEVEL SECURITY` | 212 |
| views com `security_invoker` | 34 |

## Extensions referenciadas pelo `public` (ver `schema-extensions-prelude.sql`)

| Extension | Schema | Uso no snapshot |
|---|---|---|
| uuid-ossp | extensions | `extensions.uuid_generate_v4()` |
| pgcrypto | extensions | `extensions.gen_random_bytes()` |
| pg_trgm | extensions | `extensions.gin_trgm_ops` |
| vector | public | `public.vector(1536)`, `public.vector_cosine_ops` |
| pg_cron | cron | views `v_cron_jobs_*` leem `cron.job` |
