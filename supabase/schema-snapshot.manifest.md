# Manifest — `schema-snapshot.sql`

> Contagens do snapshot. Ao re-gerar o dump, atualize esta tabela: o **diff do git é a revisão do drift** de schema entre uma geração e a próxima.

| Campo | Valor |
|---|---|
| Gerado em | 2026-07-21 |
| Fonte | produção (Supabase Lovable, `fzvklzpomgnyikkfkzai`) — **gerado via `pg_dump` por `~/.config/afiacao/psql-ro`** (read-only, role `claude_ro`). Idêntico objeto-por-objeto ao dump do chat do Lovable (cross-validado no #1093); difere só no **preâmbulo** do `pg_dump`: token `\restrict`, versão 17.9→17.10, e `client_encoding` SQL_ASCII→UTF8 / `standard_conforming_strings` off→on (estilo da ferramenta, **não** conteúdo — corpo dos objetos idêntico; cada dump é internamente consistente; replay valida o restore). |
| Versão do banco | PostgreSQL 17.6 |
| pg_dump | 17.10 (Homebrew, via psql-ro) |
| Flags | `--schema-only --schema=public --schema=private --no-owner --no-privileges` |
| Linhas do arquivo | 45.022 (anterior no HEAD: 36.907 — ver ⚠️ abaixo sobre a divergência manifest × arquivo) |
| Tamanho | ~1,7 MB |

> **Geração anterior (2026-05-24, pg_dump 17.9, 23.745 linhas) estava gravemente stale:** faltavam ~60 tabelas, ~124 funções, ~105 policies, ~75 índices criados por migrations posteriores (inclui o drift da Opção A: `farmer_client_scores`/`customer_visit_scores` → `UNIQUE(customer_user_id)` + `idx_fcs_customer`/`idx_cvs_customer`). As ~16 policies + 1 matview que "sumiram" são **remoções reais** em prod (hardening de RLS substituiu as policies amplas `"Staff can manage …"` pelas granulares por carteira; matview `mv_sku_ranking_negociacao_paralela` **movida para o schema `private`** — NÃO dropada; ver §"Schema `private`" abaixo) — confirmado via psql-ro.

## Contagens por tipo (schema `public`)

| Objeto | Quantidade |
|---|---:|
| `CREATE TABLE` | 323 |
| `CREATE VIEW` | 77 |
| `CREATE MATERIALIZED VIEW` | 2 (public; +3 em `private` = 5 no arquivo) |
| `CREATE FUNCTION` | 303 (public) **+ 14 em `private`** |
| `CREATE TRIGGER` | 123 |
| `CREATE TYPE` | 14 |
| `CREATE POLICY` | 678 |
| `ENABLE ROW LEVEL SECURITY` | 323 (= todas as tabelas) |
| views com `security_invoker` | 72 |

## ✅ Schema `private` incluído + replay VALIDADO (2026-06-19)

A geração **+`private`** (35.485 linhas) dumpa o schema `private`: `CREATE SCHEMA private` + o matview `private.mv_sku_ranking_negociacao_paralela` + 2 índices (`idx_mv_ranking_pk`, `idx_mv_ranking_categoria`). Isso **fecha o gap** da 1ª geração de 2026-06-19 (public-only), em que 3 objetos do `public` (`get_sku_ranking_negociacao_paralela` / `refresh_sku_ranking_negociacao` + view `v_sugestao_negociacao_ativa`) referenciavam o matview sem ele ser dumpado → o restore quebrava com `schema "private" does not exist`. O matview foi movido `public`→`private` pela migration `20260527160000` (segurança — tirar o ranking cru do PostgREST, deixá-lo atrás de RPCs SECURITY DEFINER).

> **Replay VALIDADO em 2026-06-19** (`db/verify-snapshot-replay.sh`, PG17 descartável + prelude + stubs, transação única `ON_ERROR_STOP`): restore **limpo** + contagens públicas batem (272/53/3/210/91/14/579) + **enforcement RLS amostrado OK** (own-scope=1 / staff-gate=2 / anon-deny=0). **Limitação:** prova ordem/dependência/sintaxe + RLS amostrada do `public`; **não** o runtime Supabase completo ("Gold" pede projeto vazio/docker).

> **Re-validado em 2026-06-24** (geração 36.129 linhas): `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **274/55/3/218/95/14/579** (drift desde 06-19: +2 tabelas, +2 views, +8 funções, +4 triggers — vários PRs mergeados). ✅ A policy ALL antiga de `farmer_tactical_plans` saiu (split [#1043](https://github.com/LucasSardenbergL/afiacao/pull/1043)) e as RPCs v2 hardened entraram ([#1046](https://github.com/LucasSardenbergL/afiacao/pull/1046): FOR UPDATE + status-guard) — confirmado no snapshot. **Fecha o #6 do `/codex challenge`.**

> **Re-validado em 2026-06-26** (geração 36.235 linhas, +106 vs 06-24): `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **274/55/3/219/95/14/579** (drift desde 06-24: **+1 função**). Diff do drift (06-24→06-26): (1) colunas `estoque_fisico`/`estoque_a_caminho` + COMMENTs em `pedido_compra_item` e o INSERT correspondente em `gerar_pedidos_sugeridos_ciclo` — migration `20260626150457` (PR #1079), **agora registrada em `supabase_migrations.schema_migrations`** (era apply manual via SQL Editor, sem registro; reconciliada nesta sessão); (2) função nova `get_ultimos_precos_cliente` (migration `20260625120000`); (3) check `pedidos_compra_sync` no `_data_health_compute`/`data_health_watchdog` — migration `20260626150000` ([#1081](https://github.com/LucasSardenbergL/afiacao/pull/1081), mergeado 27/06). ⚠️ **Snapshot é retrato de ~26/06 20:20 UTC — já stale p/ #1090:** [#1090](https://github.com/LucasSardenbergL/afiacao/pull/1090) (motor galão econômico, mergeado 27/06 00:13 UTC) recriou `gerar_pedidos_sugeridos_ciclo` em prod (md5 `b4eff3ec…`→`00663b74…`) via `db/embalagem-motor-rpc.sql`, **sem migration formal** em `supabase/migrations/` → **fora deste snapshot**. Contagens seguem válidas (REPLACE não muda nº de objeto); só o corpo dessa função está defasado. **Pendente: re-dump p/ capturar #1090.** _(✅ RESOLVIDO na geração 2026-06-27 — ver nota a seguir.)_

> **Re-gerado em 2026-06-27** (36.608 linhas, +373 vs 06-26) — **fecha o "Pendente: re-dump p/ #1090".** Fonte: `pg_dump` via `~/.config/afiacao/psql-ro` (read-only; o founder optou por gerar direto, já que o dump é idêntico-OBJETO ao do chat do Lovable — difere só no preâmbulo do `pg_dump`: token `restrict`, versão, e `client_encoding`/`standard_conforming_strings` (UTF8/on no pg_dump nativo vs SQL_ASCII/off do Lovable; estilo da ferramenta, não conteúdo — replay valida o restore)). `db/verify-snapshot-replay.sh` → restore **limpo** + RLS amostrada OK (own=1/staff=2/anon=0); contagens públicas **276/57/3/221/95/14/581**. Drift do diff (06-26→06-27) **100% aditivo, 0 objetos removidos** — `md5(pg_get_functiondef)` de `gerar_pedidos_sugeridos_ciclo` **prod × snapshot agora batem (`00663b74…`)**: (1) **#1090** (motor galão, [PR #1090](https://github.com/LucasSardenbergL/afiacao/pull/1090)) recriou a função — REPLACE, não muda contagem — **agora também formalizada** na migration `20260627132029_reposicao_embalagem_motor_galao.sql` (corpo byte-idêntico a `db/embalagem-motor-rpc.sql`; guard de paridade em `src/lib/reposicao/__tests__/embalagem-motor-paridade.test.ts`); (2) **cold-start** (#1087): `reposicao_cold_start_log` + `v_reposicao_cold_start_elegivel` + `reposicao_cold_start_parametros` + 1 policy (migrations `20260626210000`/`20260627130000`); (3) **de-para Sayerlack auto**: `reposicao_depara_auto_log` + `v_reposicao_depara_sayerlack_elegivel` + `reposicao_aplicar_depara_sayerlack_auto` + 1 policy (migration `20260626193000`). → +2 tabela/view/função/policy (as 2 features); `ENABLE RLS` 269→271 e `security_invoker` 53→55. ⚠️ **`schema_migrations` ainda atrás:** `20260625120000`/`20260626150000`/`20260626193000`/`20260626210000`/`20260627130000` estão aplicadas mas **não registradas** (backlog de registro — fora do escopo deste re-dump; ver achado da sessão).

> **Re-gerado em 2026-07-21** (45.022 linhas, **+8.115** vs o arquivo que estava no HEAD) — fecha uma janela de **24 dias** em que o DR restauraria um estado ANTERIOR à matriz de autorização E2/FU4. Fonte: `pg_dump` 17.10 via `~/.config/afiacao/psql-ro` (read-only). `db/verify-snapshot-replay.sh` → restore **limpo** (`exit 0`) + RLS amostrada OK (own=1/staff=2/anon=0); contagens do replay **323/77/2/303/125/14/678**, com **paridade objeto-a-objeto verificada contra o catálogo de prod** (`pg_class`/`pg_proc`/`pg_policies`): 323/323 tabelas · 77/77 views · 302/302 funções · 678/678 policies — **0 faltando, 0 sobrando**.
>
> **Drift medido 06-27 → 07-21** (104 migrations custom no intervalo): **+51 tabelas** (módulos PCP, Prime, pedidos programados e `fin_dividas*` inteiros), **+19 views**, **+82 funções**, **+112 policies novas**, **−17 policies** removidas em prod. ⚠️ **O número que importa não é nenhum desses: são as 61 policies que existiam no snapshot com o NOME certo e o CORPO velho** — invisíveis a qualquer diff por nome, e por isso o stale passou despercebido. Das 79 policies que hoje chamam `private.cap_*`, **61 já estavam no snapshot sob o mesmo nome, com o gate pré-FU4**. Exemplo verificado: `staff_pedido_compra_item_select` era `has_role(uid,'master') OR has_role(uid,'employee')` (qualquer employee lê custo de compra) e em prod é `(SELECT private.cap_compras_ler((SELECT auth.uid())))`. Um DR reinstalaria o gate largo **sob um nome que parece correto**. Também entraram agora **as 14 funções do schema `private`** (`cap_compras_ler`/`cap_compras_escrever`/`cap_custo_ler`/`cap_carteira_*`/`cap_preco_escrever`/`cap_credito_escrever`/`cap_pedido_escrever`/`cap_regua_log_escrever` + `pode_ver_carteira_completa`/`carteira_visivel_para`/`is_super_admin`/`regua_*`) — o snapshot anterior tinha **zero** delas: só os matviews de `private`.
>
> ⚠️ **Achado adjacente — este manifest descrevia um arquivo que não estava mais lá.** A entrada de 06-27 registra "36.608 linhas, `pg_dump` via `psql-ro`", mas o arquivo no HEAD tinha **36.907** linhas e preâmbulo `pg_dump 17.9` + `client_encoding=SQL_ASCII` + `standard_conforming_strings=off` — que é a assinatura do **chat do Lovable**, não a do dump nativo (17.10 / UTF8 / on). O que houve: o dump do founder entrou pelo #1101 (27/06 14:06 UTC) e **4h30 depois o commit `d3a842f0` "Changes" o substituiu** pelo dump do próprio Lovable, sem que o manifest fosse corrigido. É a irmã da armadilha do sync bidirecional já documentada no `CLAUDE.md` — aqui não reverteu, **substituiu**. ⇒ Ao re-gerar, confira o preâmbulo (`Dumped by` + `client_encoding`) contra a linha "Fonte" desta tabela: divergir significa que outra geração entrou por cima.
>
> ℹ️ **Contexto de DR:** neste intervalo o caminho alternativo também deixou de replayar — `20260720120000_...fu4g.sql` aborta de propósito se `public.reposicao_pos_candidatos(text)` não existir, e a migration que a cria é `20260721190000`, **lexicograficamente posterior**. Ou seja, entre 27/06 e este re-dump **nem o snapshot nem `supabase/migrations/` reproduziam prod**. O snapshot segue sendo a fonte de DR (§"Por que existe"); esta nota existe só para que ninguém tente o replay das migrations como plano B durante um incidente.

## Extensions referenciadas pelo `public` (ver `schema-extensions-prelude.sql`)

| Extension | Schema | Uso no snapshot |
|---|---|---|
| uuid-ossp | extensions | `extensions.uuid_generate_v4()` |
| pgcrypto | extensions | `extensions.gen_random_bytes()` |
| pg_trgm | extensions | `extensions.gin_trgm_ops` |
| vector | public | `public.vector(1536)`, `public.vector_cosine_ops` |
| pg_cron | cron | views `v_cron_jobs_*` leem `cron.job` |
