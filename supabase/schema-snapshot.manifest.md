# Manifest — `schema-snapshot.sql`

> Contagens do snapshot. Ao re-gerar o dump, atualize esta tabela: o **diff do git é a revisão do drift** de schema entre uma geração e a próxima.

| Campo | Valor |
|---|---|
| Gerado em | 2026-06-24 |
| Fonte | produção (Supabase Lovable, `fzvklzpomgnyikkfkzai`) — regen via chat do Lovable; conteúdo **cross-validado** por um `pg_dump` independente via `~/.config/afiacao/psql-ro` (idêntico objeto-por-objeto, só difere no header/token) |
| Versão do banco | PostgreSQL 17.6 |
| pg_dump | 17.9 |
| Flags | `--schema-only --schema=public --schema=private --no-owner --no-privileges` |
| Linhas do arquivo | 36.129 (geração +`private`; anterior 2026-06-19: 35.485) |
| Tamanho | ~1,3 MB |

> **Geração anterior (2026-05-24, pg_dump 17.9, 23.745 linhas) estava gravemente stale:** faltavam ~60 tabelas, ~124 funções, ~105 policies, ~75 índices criados por migrations posteriores (inclui o drift da Opção A: `farmer_client_scores`/`customer_visit_scores` → `UNIQUE(customer_user_id)` + `idx_fcs_customer`/`idx_cvs_customer`). As ~16 policies + 1 matview que "sumiram" são **remoções reais** em prod (hardening de RLS substituiu as policies amplas `"Staff can manage …"` pelas granulares por carteira; matview `mv_sku_ranking_negociacao_paralela` **movida para o schema `private`** — NÃO dropada; ver §"Schema `private`" abaixo) — confirmado via psql-ro.

## Contagens por tipo (schema `public`)

| Objeto | Quantidade |
|---|---:|
| `CREATE TABLE` | 274 |
| `CREATE VIEW` | 55 |
| `CREATE MATERIALIZED VIEW` | 3 (public; +1 `private.mv_sku_ranking_negociacao_paralela` = 4 no texto) |
| `CREATE FUNCTION` | 218 |
| `CREATE TRIGGER` | 95 |
| `CREATE TYPE` | 14 |
| `CREATE POLICY` | 579 |
| `ENABLE ROW LEVEL SECURITY` | 269 |
| views com `security_invoker` | 53 |

## ✅ Schema `private` incluído + replay VALIDADO (2026-06-19)

A geração **+`private`** (35.485 linhas) dumpa o schema `private`: `CREATE SCHEMA private` + o matview `private.mv_sku_ranking_negociacao_paralela` + 2 índices (`idx_mv_ranking_pk`, `idx_mv_ranking_categoria`). Isso **fecha o gap** da 1ª geração de 2026-06-19 (public-only), em que 3 objetos do `public` (`get_sku_ranking_negociacao_paralela` / `refresh_sku_ranking_negociacao` + view `v_sugestao_negociacao_ativa`) referenciavam o matview sem ele ser dumpado → o restore quebrava com `schema "private" does not exist`. O matview foi movido `public`→`private` pela migration `20260527160000` (segurança — tirar o ranking cru do PostgREST, deixá-lo atrás de RPCs SECURITY DEFINER).

> **Replay VALIDADO em 2026-06-19** (`db/verify-snapshot-replay.sh`, PG17 descartável + prelude + stubs, transação única `ON_ERROR_STOP`): restore **limpo** + contagens públicas batem (272/53/3/210/91/14/579) + **enforcement RLS amostrado OK** (own-scope=1 / staff-gate=2 / anon-deny=0). **Limitação:** prova ordem/dependência/sintaxe + RLS amostrada do `public`; **não** o runtime Supabase completo ("Gold" pede projeto vazio/docker).

> **Re-validado em 2026-06-24** (geração 36.129 linhas): `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **274/55/3/218/95/14/579** (drift desde 06-19: +2 tabelas, +2 views, +8 funções, +4 triggers — vários PRs mergeados). ✅ A policy ALL antiga de `farmer_tactical_plans` saiu (split [#1043](https://github.com/LucasSardenbergL/afiacao/pull/1043)) e as RPCs v2 hardened entraram ([#1046](https://github.com/LucasSardenbergL/afiacao/pull/1046): FOR UPDATE + status-guard) — confirmado no snapshot. **Fecha o #6 do `/codex challenge`.**

## Extensions referenciadas pelo `public` (ver `schema-extensions-prelude.sql`)

| Extension | Schema | Uso no snapshot |
|---|---|---|
| uuid-ossp | extensions | `extensions.uuid_generate_v4()` |
| pgcrypto | extensions | `extensions.gen_random_bytes()` |
| pg_trgm | extensions | `extensions.gin_trgm_ops` |
| vector | public | `public.vector(1536)`, `public.vector_cosine_ops` |
| pg_cron | cron | views `v_cron_jobs_*` leem `cron.job` |
