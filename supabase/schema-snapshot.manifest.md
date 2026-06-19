# Manifest — `schema-snapshot.sql`

> Contagens do snapshot. Ao re-gerar o dump, atualize esta tabela: o **diff do git é a revisão do drift** de schema entre uma geração e a próxima.

| Campo | Valor |
|---|---|
| Gerado em | 2026-06-19 |
| Fonte | produção (Supabase Lovable, `fzvklzpomgnyikkfkzai`) — regen via chat do Lovable; conteúdo **cross-validado** por um `pg_dump` independente via `~/.config/afiacao/psql-ro` (idêntico objeto-por-objeto, só difere no header/token) |
| Versão do banco | PostgreSQL 17.6 |
| pg_dump | 17.9 |
| Flags | `--schema-only --schema=public --no-owner --no-privileges` |
| Linhas do arquivo | 35.367 |
| Tamanho | ~1,3 MB |

> **Geração anterior (2026-05-24, pg_dump 17.9, 23.745 linhas) estava gravemente stale:** faltavam ~60 tabelas, ~124 funções, ~105 policies, ~75 índices criados por migrations posteriores (inclui o drift da Opção A: `farmer_client_scores`/`customer_visit_scores` → `UNIQUE(customer_user_id)` + `idx_fcs_customer`/`idx_cvs_customer`). As ~16 policies + 1 matview que "sumiram" são **remoções reais** em prod (hardening de RLS substituiu as policies amplas `"Staff can manage …"` pelas granulares por carteira; matview `mv_sku_ranking_negociacao_paralela` **movida para o schema `private`** — NÃO dropada; ver §"Dependência `private`" abaixo) — confirmado via psql-ro.

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

## ⚠️ Dependência externa NOVA: schema `private` (gap de DR desta geração — achado no replay)

Esta geração é `--schema=public`, mas **3 objetos do `public` referenciam `private.mv_sku_ranking_negociacao_paralela`** — as funções `get_sku_ranking_negociacao_paralela` / `refresh_sku_ranking_negociacao` (SECURITY DEFINER) e a view `v_sugestao_negociacao_ativa` — e o matview **NÃO é dumpado** (vive em `private`, pra onde a migration `20260527160000` o moveu por segurança: tirar o ranking cru do PostgREST, deixá-lo atrás dos RPCs). Logo **o snapshot sozinho NÃO restaura**: `db/verify-snapshot-replay.sh` aborta no 1º ref com `ERROR: schema "private" does not exist` (provado 2026-06-19). O schema `private` tem só esse matview + 2 índices (`idx_mv_ranking_pk`, `idx_mv_ranking_categoria`).

**Fix (próxima regeneração):** incluir `--schema=private` no pg_dump — o prompt do `README-schema.md` §"Como re-gerar" já foi atualizado. Aí o snapshot volta a ser self-contained e o replay passa. Enquanto isso, um restore precisa criar `private` antes (rodar `20260527160000`).

> **Replay:** a validação limpa de **2026-05-24** vale só para a geração antiga (public-only, 212/37/4/86/76/14/474). Esta (2026-06-19) **só passa após re-regenerar com `--schema=private`** — por isso este manifest **não** declara replay-validado.

## Extensions referenciadas pelo `public` (ver `schema-extensions-prelude.sql`)

| Extension | Schema | Uso no snapshot |
|---|---|---|
| uuid-ossp | extensions | `extensions.uuid_generate_v4()` |
| pgcrypto | extensions | `extensions.gen_random_bytes()` |
| pg_trgm | extensions | `extensions.gin_trgm_ops` |
| vector | public | `public.vector(1536)`, `public.vector_cosine_ops` |
| pg_cron | cron | views `v_cron_jobs_*` leem `cron.job` |
