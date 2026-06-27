# Manifest — `schema-snapshot.sql`

> Contagens do snapshot. Ao re-gerar o dump, atualize esta tabela: o **diff do git é a revisão do drift** de schema entre uma geração e a próxima.

| Campo | Valor |
|---|---|
| Gerado em | 2026-06-27 |
| Fonte | produção (Supabase Lovable, `fzvklzpomgnyikkfkzai`) — **gerado via `pg_dump` por `~/.config/afiacao/psql-ro`** (read-only, role `claude_ro`). Idêntico objeto-por-objeto ao dump do chat do Lovable (cross-validado no #1093); difere só no **preâmbulo** do `pg_dump`: token `\restrict`, versão 17.9→17.10, e `client_encoding` SQL_ASCII→UTF8 / `standard_conforming_strings` off→on (estilo da ferramenta, **não** conteúdo — corpo dos objetos idêntico; cada dump é internamente consistente; replay valida o restore). |
| Versão do banco | PostgreSQL 17.6 |
| pg_dump | 17.10 (Homebrew, via psql-ro) |
| Flags | `--schema-only --schema=public --schema=private --no-owner --no-privileges` |
| Linhas do arquivo | 36.608 (geração +`private`; anterior 2026-06-26: 36.235) |
| Tamanho | ~1,3 MB |

> **Geração anterior (2026-05-24, pg_dump 17.9, 23.745 linhas) estava gravemente stale:** faltavam ~60 tabelas, ~124 funções, ~105 policies, ~75 índices criados por migrations posteriores (inclui o drift da Opção A: `farmer_client_scores`/`customer_visit_scores` → `UNIQUE(customer_user_id)` + `idx_fcs_customer`/`idx_cvs_customer`). As ~16 policies + 1 matview que "sumiram" são **remoções reais** em prod (hardening de RLS substituiu as policies amplas `"Staff can manage …"` pelas granulares por carteira; matview `mv_sku_ranking_negociacao_paralela` **movida para o schema `private`** — NÃO dropada; ver §"Schema `private`" abaixo) — confirmado via psql-ro.

## Contagens por tipo (schema `public`)

| Objeto | Quantidade |
|---|---:|
| `CREATE TABLE` | 276 |
| `CREATE VIEW` | 57 |
| `CREATE MATERIALIZED VIEW` | 3 (public; +1 `private.mv_sku_ranking_negociacao_paralela` = 4 no texto) |
| `CREATE FUNCTION` | 221 |
| `CREATE TRIGGER` | 95 |
| `CREATE TYPE` | 14 |
| `CREATE POLICY` | 581 |
| `ENABLE ROW LEVEL SECURITY` | 271 |
| views com `security_invoker` | 55 |

## ✅ Schema `private` incluído + replay VALIDADO (2026-06-19)

A geração **+`private`** (35.485 linhas) dumpa o schema `private`: `CREATE SCHEMA private` + o matview `private.mv_sku_ranking_negociacao_paralela` + 2 índices (`idx_mv_ranking_pk`, `idx_mv_ranking_categoria`). Isso **fecha o gap** da 1ª geração de 2026-06-19 (public-only), em que 3 objetos do `public` (`get_sku_ranking_negociacao_paralela` / `refresh_sku_ranking_negociacao` + view `v_sugestao_negociacao_ativa`) referenciavam o matview sem ele ser dumpado → o restore quebrava com `schema "private" does not exist`. O matview foi movido `public`→`private` pela migration `20260527160000` (segurança — tirar o ranking cru do PostgREST, deixá-lo atrás de RPCs SECURITY DEFINER).

> **Replay VALIDADO em 2026-06-19** (`db/verify-snapshot-replay.sh`, PG17 descartável + prelude + stubs, transação única `ON_ERROR_STOP`): restore **limpo** + contagens públicas batem (272/53/3/210/91/14/579) + **enforcement RLS amostrado OK** (own-scope=1 / staff-gate=2 / anon-deny=0). **Limitação:** prova ordem/dependência/sintaxe + RLS amostrada do `public`; **não** o runtime Supabase completo ("Gold" pede projeto vazio/docker).

> **Re-validado em 2026-06-24** (geração 36.129 linhas): `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **274/55/3/218/95/14/579** (drift desde 06-19: +2 tabelas, +2 views, +8 funções, +4 triggers — vários PRs mergeados). ✅ A policy ALL antiga de `farmer_tactical_plans` saiu (split [#1043](https://github.com/LucasSardenbergL/afiacao/pull/1043)) e as RPCs v2 hardened entraram ([#1046](https://github.com/LucasSardenbergL/afiacao/pull/1046): FOR UPDATE + status-guard) — confirmado no snapshot. **Fecha o #6 do `/codex challenge`.**

> **Re-validado em 2026-06-26** (geração 36.235 linhas, +106 vs 06-24): `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **274/55/3/219/95/14/579** (drift desde 06-24: **+1 função**). Diff do drift (06-24→06-26): (1) colunas `estoque_fisico`/`estoque_a_caminho` + COMMENTs em `pedido_compra_item` e o INSERT correspondente em `gerar_pedidos_sugeridos_ciclo` — migration `20260626150457` (PR #1079), **agora registrada em `supabase_migrations.schema_migrations`** (era apply manual via SQL Editor, sem registro; reconciliada nesta sessão); (2) função nova `get_ultimos_precos_cliente` (migration `20260625120000`); (3) check `pedidos_compra_sync` no `_data_health_compute`/`data_health_watchdog` — migration `20260626150000` ([#1081](https://github.com/LucasSardenbergL/afiacao/pull/1081), mergeado 27/06). ⚠️ **Snapshot é retrato de ~26/06 20:20 UTC — já stale p/ #1090:** [#1090](https://github.com/LucasSardenbergL/afiacao/pull/1090) (motor galão econômico, mergeado 27/06 00:13 UTC) recriou `gerar_pedidos_sugeridos_ciclo` em prod (md5 `b4eff3ec…`→`00663b74…`) via `db/embalagem-motor-rpc.sql`, **sem migration formal** em `supabase/migrations/` → **fora deste snapshot**. Contagens seguem válidas (REPLACE não muda nº de objeto); só o corpo dessa função está defasado. **Pendente: re-dump p/ capturar #1090.** _(✅ RESOLVIDO na geração 2026-06-27 — ver nota a seguir.)_

> **Re-gerado em 2026-06-27** (36.608 linhas, +373 vs 06-26) — **fecha o "Pendente: re-dump p/ #1090".** Fonte: `pg_dump` via `~/.config/afiacao/psql-ro` (read-only; o founder optou por gerar direto, já que o dump é idêntico-OBJETO ao do chat do Lovable — difere só no preâmbulo do `pg_dump`: token `restrict`, versão, e `client_encoding`/`standard_conforming_strings` (UTF8/on no pg_dump nativo vs SQL_ASCII/off do Lovable; estilo da ferramenta, não conteúdo — replay valida o restore)). `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **276/57/3/221/95/14/581**. Drift do diff (06-26→06-27) **100% aditivo, 0 objetos removidos** — `md5(pg_get_functiondef)` de `gerar_pedidos_sugeridos_ciclo` **prod × snapshot agora batem (`00663b74…`)**: (1) **#1090** (motor galão, [PR #1090](https://github.com/LucasSardenbergL/afiacao/pull/1090)) recriou a função — REPLACE, não muda contagem — **agora também formalizada** na migration `20260627132029_reposicao_embalagem_motor_galao.sql` (corpo byte-idêntico a `db/embalagem-motor-rpc.sql`; guard de paridade em `src/lib/reposicao/__tests__/embalagem-motor-paridade.test.ts`); (2) **cold-start** (#1087): `reposicao_cold_start_log` + `v_reposicao_cold_start_elegivel` + `reposicao_cold_start_parametros` + 1 policy (migrations `20260626210000`/`20260627130000`); (3) **de-para Sayerlack auto**: `reposicao_depara_auto_log` + `v_reposicao_depara_sayerlack_elegivel` + `reposicao_aplicar_depara_sayerlack_auto` + 1 policy (migration `20260626193000`). → +2 tabela/view/função/policy (as 2 features); `ENABLE RLS` 269→271 e `security_invoker` 53→55. ⚠️ **`schema_migrations` ainda atrás:** `20260625120000`/`20260626150000`/`20260626193000`/`20260626210000`/`20260627130000` estão aplicadas mas **não registradas** (backlog de registro — fora do escopo deste re-dump; ver achado da sessão).

## Extensions referenciadas pelo `public` (ver `schema-extensions-prelude.sql`)

| Extension | Schema | Uso no snapshot |
|---|---|---|
| uuid-ossp | extensions | `extensions.uuid_generate_v4()` |
| pgcrypto | extensions | `extensions.gen_random_bytes()` |
| pg_trgm | extensions | `extensions.gin_trgm_ops` |
| vector | public | `public.vector(1536)`, `public.vector_cosine_ops` |
| pg_cron | cron | views `v_cron_jobs_*` leem `cron.job` |
