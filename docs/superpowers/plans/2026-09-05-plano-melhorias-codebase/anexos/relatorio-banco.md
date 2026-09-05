# Auditoria read-only — banco (snapshot, migrations, db/, cron) — 2026-09-05

> Fonte do estado de produção: `supabase/schema-snapshot.sql` (51.692 linhas, `pg_dump 17.9`, commit `1851416fc` de 2026-09-05 — ver B01 sobre a proveniência).
> Nada foi executado contra o banco; nenhum arquivo do repo foi tocado. Artefatos intermediários (TSVs de policies/FKs/índices/funções/crons) em `$SP/*.tsv|txt`.
> Limite declarado: o dump é `--no-privileges` ⇒ **GRANT/ACL de hoje não são verificáveis aqui**; o que vale para ACL é `db/authz-carimbo-prod.json` (medido 2026-08-29, 5 audits, 0 achados).

---

## Achados

`ID | título | categoria | evidência | por que importa | proposta | I·R·E`

**B01 | Snapshot de DR de 09-05 veio pelo bot do Lovable — sem as 3 provas do `refresh-snapshot.sh` e com manifest defasado | infra/documentação**
Evidência: `git log -1 1851416fc` → author `gpt-engineer-app[bot]`, msg "Changes" (+836/−24, só o snapshot); `supabase/schema-snapshot.manifest.md:7` "Gerado em 2026-08-28", `:12` "50.880 linhas" vs `wc -l` = 51.692; preâmbulo do dump "pg_dump version 17.9" (Lovable) enquanto o manifest documenta 17.10 (psql-ro); `supabase/README-schema.md:49` "replay VALIDADO em 2026-08-08"; `db/refresh-snapshot.sh` é o único caminho que faz integridade + paridade objeto-a-objeto + replay PG17 e atualiza o manifest (2 refs) — não foi usado.
Por que importa: o snapshot é a ÚNICA reprodução de prod (`database.md` §3: migrations não replayam); a versão atual no repo não tem evidência de paridade nem de replay, e o manifest (que é "a revisão do drift entre gerações") descreve outro arquivo.
Proposta: (1) `bash db/refresh-snapshot.sh` na máquina com `psql-ro` para regerar COM provas + manifest; (2) gate barato no CI, `scripts/snapshot-manifest.gate.ts`: `wc -l` do snapshot == "Linhas do arquivo" do manifest e a data do cabeçalho do README == a do manifest — falha exatamente no re-dump por bot que pula o script.
I=4 · R=3 · E=2

**B02 | O audit de migrations não tem "carimbo": o resultado de prod nunca é commitado, e o SQL gerado (4.460 linhas) é regenerado a cada migration | arquitetura**
Evidência: `scripts/audit-custom-migrations.sql` 268 commits e `docs/migrations-audit.md` 268 commits (último 09-04) vs `.ts` 8 commits — cada migration nova regenera 4.4k linhas de SQL para colar; `package.json:22` `audit:migrations` só GERA, o output de rodar em prod não existe em lugar nenhum do repo (compare com `db/authz-carimbo-prod.json`, que é lido pelo CI com frescor); Seção 3 "DERIVA" (`audit-custom-migrations.ts:258-340`) nasceu no #2105 e sua triagem vive só em prosa (`docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md`: 24 derivas, 8 reais, todas com prod MAIS NOVO); `docs/historico/schema-migrations-fail-open.md` §"Pendência ABERTA": o registro `schema_migrations` erra nos dois sentidos (#2139/#2141).
Por que importa: o repo só "sabe" o que está aplicado quando alguém lembra de colar 4.4k linhas no SQL Editor e ler o resultado — e a `database.md` §2 já registra que o arquivo é ímã de conflito sob auto-merge (reconflitou em loop no #1243). É o mesmo buraco que o carimbo de authz fechou em 2026-08-25, na fatia de migrations.
Proposta: (1) adicionar um audit `migracoes:prod` ao padrão `AUDITS` de `scripts/lib/authz-carimbo.ts` (gravado via psql-ro → `db/migracoes-carimbo-prod.json` com os 5 estados por migration + a Seção 3 por função; CI lê com `--exigir-frescor` na main); (2) parar de commitar `scripts/audit-custom-migrations.sql` — gerar no momento do paste (`bun run audit:migrations -- --sql`) e manter só o inventário `.md`.
I=4 · R=3 · E=3

**B03 | O app chama a RPC `gerar_fila_aplicacao_omie`, que não existe em prod nem no repo (cast `as never` esconde) | código**
Evidência: `src/components/reposicao/aplicacao/useAplicacaoFila.ts:127` `supabase.rpc("gerar_fila_aplicacao_omie" as never, …)` (mutation "gerar fila" da página `AdminReposicaoAplicacao.tsx`); snapshot: 0 ocorrências; `supabase/migrations/`: 0; docs: 0. O hook está assim desde 2026-05-24 (`354bef98b`). Há **34** call sites `.rpc('<nome>' as never` em `src/` (fora testes) — este é o único cujo nome não existe no snapshot.
Por que importa: clicar "Gerar fila" devolve PGRST202 ("function not found") em prod — botão morto há 3+ meses; o `as never` é o mecanismo que deixa o typecheck verde.
Proposta: decidir entre remover a mutation/botão ou criar a RPC (via `lovable-db-operator`); e um gate `scripts/rpc-existe.gate.ts` que extrai os nomes de `rpc('x' as never)` e exige `CREATE FUNCTION public.x(` no snapshot — roda no CI sem banco, porque o snapshot está no repo.
I=3 · R=2 · E=2

**B04 | 12 funções `public` sem consumidor em lugar nenhum (rpc/src/edges/cron/corpo de outra função); 4 delas nem migration têm; 4 são SECURITY DEFINER | código/segurança**
Evidência (`$SP/fn_orfas.txt`, cruzado com 123 nomes distintos em `.rpc()` de src+edges, `\bnome(` no snapshot fora da própria definição, `cron.schedule` nas migrations e runbook): `_tint_preflight`, `fn_pcp_derivar_rotas_simples`*, `fn_pcp_materializar_excecoes`*, `fn_pcp_refresh_itens`* (sem migration alguma), `get_customer_metrics`* (7 migrations, 0 chamadores), `rodar_bateria_simulacao`, `validar_sku_para_aplicacao`, `fornecedor_operacional`, `fornecedor_polling_pendente`, `registrar_polling_resultado`, `proxima_janela_operacional`, `atualizar_campanha_datas_corte` (* = SECDEF). Nenhuma está na allowlist de 43 do carimbo (`db/authz-carimbo-prod.json`).
Por que importa: 4 SECDEF alcançáveis pelo PostgREST se `proacl` for NULL (o default concede a PUBLIC — `database.md` §5, FU7-b) e fora de qualquer sentinela. `money-path.md` §"Aposentar código" avisa que "quem chama?" no repo não basta (Zapier/n8n/BI não aparecem no grep).
Proposta: aplicar o padrão de quarentena que o repo já usa (renomear → observar `pg_stat_user_functions.calls` via psql-ro por 1 ciclo → `DROP`); antes disso, incluir as 4 SECDEF na allowlist do `authz:funcoes:prod` para o carimbo medir o EXECUTE delas.
I=2 · R=2 · E=2

**B05 | 116 de 204 FKs sem índice na coluna referenciadora; 26 são `ON DELETE CASCADE` e 17 `SET NULL` | perf**
Evidência (`$SP/fk_sem_indice.tsv`): `tint_staging_formula_itens.sync_run_id` / `tint_staging_corantes` / `tint_staging_cores_*` / `tint_staging_preparacao_itens` (CASCADE → `tint_sync_runs`), `tint_formula_itens.corante_id` (tabela de 3,4M linhas — manifest 08-08), `picking_events.picking_task_id` e `.picking_task_item_id` (CASCADE), `production_orders.sales_order_id`, `sales_price_history.sales_order_id`, `inventory_position.product_id → omie_products` (7 filhos de `omie_products` sem índice), `loyalty_points.order_id`, `fin_fechamentos.snapshot_dre_*` ×3. 26 apontam para `auth.users` (CASCADE/SET NULL exige varrer o filho a cada deleção de usuário).
Por que importa: cada `DELETE`/`UPDATE` na tabela pai faz seq scan no filho (o gatilho de integridade referencial não tem índice), e os joins pai→filho também; em staging de sync (`tint_staging_*`, `pcp_malha_staging`) isso acontece a cada run.
Proposta: lote de `CREATE INDEX CONCURRENTLY` priorizado por (CASCADE/SET NULL) × tamanho, medido antes/depois por `pg_stat_user_tables.seq_scan` via psql-ro; começar por `tint_staging_*`, `picking_events`, `sales_price_history`, `tint_formula_itens.corante_id`.
I=3 · R=1 · E=2

**B06 | 18 índices redundantes: 7 duplicatas exatas + 11 índices de 1 coluna `company` cobertos por compostos em `fin_*` | perf**
Evidência (`$SP/idx_dup.txt`, `$SP/idx_prefixo.txt`): `inventory_position` — `idx_inventory_omie_account` ≡ `inventory_position_produto_account_uq` (ambos UNIQUE em `(omie_codigo_produto, account)`); `sync_state` — 2 UNIQUE iguais em `(entity_type, account)`; `pedido_compra_item` — `idx_pedido_compra_item_pedido` ≡ `idx_pedido_item_pedido`; `tint_staging_formulas` — `idx_tint_staging_formulas_run` ≡ `idx_tsf_run`; `fin_ic_matches` — `*_cp_idx` ⊂ `*_cp_unique` e `*_cr_idx` ⊂ `*_cr_unique` (mesmo `WHERE`). Prefixo: `idx_fin_cp_company(company)` ⊂ 4 compostos, idem `idx_fin_cr_company`, `idx_fin_mov_company`, `idx_fin_categorias_company`.
Por que importa: write amplification em tabelas que o sync reescreve em massa (`fin_contas_*`, `inventory_position`, `tint_staging_*`) sem nenhum ganho de leitura (btree usa o prefixo esquerdo).
Proposta: `DROP INDEX CONCURRENTLY` dos 7 exatos + dos 4 `idx_fin_*_company` após conferir `pg_stat_user_indexes.idx_scan` via psql-ro (o composto tem de estar recebendo os scans).
I=2 · R=1 · E=1

**B07 | 267 harnesses PG17 com bootstrap copiado, 0 lib comum, e só 1 em 270 carrega `safeupdate` | teste**
Evidência: `db/test-*.sh` = 270 arquivos, 84.474 linhas (312/harness); `initdb`+`pg_ctl`+`/opt/homebrew/opt/postgresql@17` em 267; `cleanup()`+`trap` em 259; stub `CREATE FUNCTION auth.uid` reescrito em 184, stub `has_role` em 104; `source db/lib|_lib|harness` = 0; `safeupdate` = 1 — a lição #1616 (`database.md` §5: "`DELETE` sem `WHERE` é recusado até dentro de SECDEF e **nenhum harness local vê isso**") está aplicada em 1 harness; `SET ROLE authenticated` 128, `request.jwt.claim` 14. Zero rodam no CI, por desenho documentado (`schema-migrations-fail-open.md` §"a classe inteira roda fora do CI").
Por que importa: cada lacuna de fidelidade (safeupdate, statement_timeout do PostgREST, roles) é corrigida por arquivo, então a lição não propaga; 100/112/56 harnesses criados em jun/jul/ago mostram que o custo cresce ~2/dia.
Proposta: `db/_harness.sh` (bootstrap PG17 portátil + `session_preload_libraries=safeupdate` + stubs `auth.*`/`has_role` + helpers `como_authenticated <uid>`/`como_anon`) para harnesses NOVOS, com gate `scripts/harness-boilerplate.gate.ts` que barra `initdb` inline em `db/test-*.sh` novo; migrar os money-path primeiro. Não tocar nos 270 de uma vez.
I=3 · R=2 · E=3

**B08 | Cron: `cron.job` vivo não é capturado em lugar nenhum; runbook/infra de DR são de 24/05 (33 crons) vs 96 jobs agendados pelo histórico do repo | infra/DR**
Evidência: `supabase/schema-rebuild-runbook.md:19` "Recriar os 33 crons" (git 2026-05-24) e `schema-infra-outside-public.sql` (05-24); `db/refresh-snapshot.sh` não menciona `cron.job` (0); `$SP/cron_all.tsv`: 170 chamadas `cron.schedule` em 63 migrations, 97 jobs distintos, 96 "vivos" por histórico (1 morto por `unschedule` posterior); o trio `data-health-watchdog` (`*/30`), `fin-sync-watchdog` (`*/30`) e `fin-sync-heartbeat` (`0 11 * * 1-5`) só existe na baseline `20260527230000_cron_baseline.sql`. Co-agendamento: 5 jobs em `*/30`, 5 em `*/15`, 4 em `*/5`, 4 em `0 6`, 4 em `0 9`, 4 em `30 7`.
Positivo (medido): os 56 jobs http vivos têm `timeout_milliseconds` (os 17 arquivos antigos sem timeout foram todos superados por re-agendamento) e 0 alvos `functions/v1/*` sem edge em `supabase/functions/`.
Por que importa: a recuperação dos crons depende de uma query que o founder tem de lembrar; um `unschedule`/duplicata feito à mão no SQL Editor não aparece em nenhum audit (o carimbo cobre authz, não cron); e o dump é a fonte que o `sync.md` manda consultar em incidente.
Proposta: `refresh-snapshot.sh` passa a dumpar `SELECT jobname, schedule, active, command FROM cron.job ORDER BY 1` em `supabase/schema-cron.sql` (as refs ao Vault são subqueries, não valores) e um check de conjunto contra `cron_all.tsv` derivado das migrations; escalonar os grupos `*/30` e `*/15` com offset (`5,35`, `7,22,37,52`).
I=3 · R=2 · E=2

**B09 | `INSERT … WITH CHECK (true)` para QUALQUER autenticado em `reposicao_motor_run` e `reposicao_estoque_nao_confirmado_log`, enquanto o SELECT é gateado por `cap_compras_ler` | segurança**
Evidência (`$SP/policies.txt`): `reposicao_motor_run_ins` / `estoque_nao_confirmado_log_ins` `FOR INSERT TO authenticated WITH CHECK (true)`; `_sel` das duas `USING (private.cap_compras_ler(auth.uid()))`; racional em `supabase/migrations/20260708171049_reposicao_motor_run_marker.sql` cabeçalho: "INSERT authenticated WITH CHECK true (não aborta a RPC INVOKER)"; a tela ancora no ÚLTIMO run (`src/pages/AdminReposicaoPedidos.tsx:395-402`). São os 2 únicos `WITH CHECK (true)` fora de `service_role` (os outros 15 são `TO service_role`).
Por que importa: uma conta de cliente pode inserir um "último run" falso via PostgREST e mudar o que o comprador vê ("N fora da compra"); o motivo do `true` (a RPC `gerar_pedidos_sugeridos_ciclo` é INVOKER) é satisfeito por `cap_compras_ler`, porque quem chama a RPC já tem a capability.
Proposta: `ALTER POLICY … WITH CHECK ((SELECT private.cap_compras_ler(auth.uid())))` nas duas, provado em harness com `SET ROLE authenticated` + GUC de customer esperando `42501` (falsificar sabotando o gate).
I=2 · R=2 · E=1

**B10 | `_quarantine_omie_clientes_20260722` segue em prod 45 dias depois — única tabela sem RLS, fora de todo audit | segurança/higiene**
Evidência: snapshot L24236 `CREATE TABLE public._quarantine_omie_clientes_20260722`, L24253 COMMENT "DROP definitivo só após um ciclo completo sem erro — ver o PR de fecho"; `ENABLE ROW LEVEL SECURITY` = 335 de 336 tabelas (a única sem é esta); `REVOKE … FROM PUBLIC, anon, authenticated` em `20260722110000_…:63` — mas o dump é `--no-privileges` e `db/authz-carimbo-prod.json` tem 0 ocorrências dela ⇒ o ACL de HOJE não está atestado por nada.
Por que importa: espelho de `omie_clientes` (dado de cliente) sem RLS e sem sentinela; o fecho planejado nunca aconteceu.
Proposta: via psql-ro conferir `has_table_privilege('anon'|'authenticated', …)` e `pg_stat_user_tables` (seq/idx scan = 0 ⇒ nenhum consumidor dormente apareceu); preservar `omie_codigo_cliente_inte…` se ainda for necessário; `DROP TABLE` pelo `lovable-db-operator`.
I=2 · R=2 · E=1

**B11 | 24 colunas `status text` sem CHECK nem enum, incluindo tabelas operacionais/money-path | tipos/constraints**
Evidência (`$SP/columns.tsv` × blocos `CREATE TABLE`): 62 colunas `status` são `text`; 24 sem `CHECK`/enum: `sales_orders` (`DEFAULT 'rascunho'`), `orders`, `picking_tasks`, `picking_task_items` (`DEFAULT 'pendente'`), `production_orders`, `loyalty_redemptions`, `referrals`, `omie_ordens_servico`, `farmer_tactical_plans`, `sync_state`, `tint_sync_runs`… O vocabulário mora só em TS (ex.: `src/lib/picking/bridge-helpers.ts:79`). Só 2 tabelas usam enum (`call_status`, `status_pedido_compra`).
Por que importa: um literal errado numa edge/RPC grava estado inalcançável em silêncio, e a UI filtra por literal — a classe "verde por dado que não foi consultado".
Proposta: nas tabelas de domínio do app (`picking_*`, `production_orders`, `loyalty_redemptions`, `referrals`, `orders`) medir `SELECT status, count(*)` via psql-ro e adicionar `CHECK (status = ANY (ARRAY[…])) NOT VALID` + `VALIDATE`; NÃO nas que espelham etapa do Omie (`omie_ordens_servico`, possivelmente `sales_orders`) — ali o CHECK quebraria o sync quando o Omie inventar um valor.
I=2 · R=2 · E=2

**B12 | Deriva estrutural cresceu e o README mede de 24/05: 72 tabelas, 59 funções e 39 views existem em prod sem `CREATE` no repo | documentação/arquitetura**
Evidência (`$SP/tables_sem_migration.txt`, `fns_sem_migration.txt`, `views_sem_migration.txt`): módulos inteiros nasceram no Lovable — `pcp_*` (13 tabelas + 20 `fn_pcp_*`), `des_*` (8), `fornecedor_*` (11), `picking_*` (3), `promocao_*` (3), `nfe_*` (3); `supabase/README-schema.md` tabela diz "~60 / ~41 / 25" (diagnóstico 2026-05-24). 41 dessas 72 tabelas são citadas por `ALTER` em migrations (tabelas-fantasma, como o README descreve).
Por que importa: (a) a DR depende 100% de B01; (b) a Seção 3 do audit (DERIVA de corpo) só vigia função que ALGUMA migration declara — 59 funções ficam invisíveis por construção, incluindo as 4 SECDEF de B04.
Proposta: `refresh-snapshot.sh` emite a set-difference (tabelas/funções/views sem CREATE no repo) como linhas do manifest — número medido e diffável a cada geração, em vez de prosa de maio. Nunca "backfillar" migrations (regra: não tocar em `supabase/migrations/`).
I=2 · R=1 · E=1

**B13 | `schema-security-report.md` descreve um banco 2× menor (474 policies/40 SECDEF) — hoje 703 policies/249 SECDEF; os 2 `WITH CHECK (true)` de B09 não estão no ledger de decisões | documentação**
Evidência: relatório datado 2026-05-24/27 ("28 `USING(true)` + 11 `WITH CHECK(true)`, todos `service_role`"); snapshot 09-05: 30 `USING (true)` (6 PUBLIC de catálogo + 9 `authenticated` de referência — iguais ao ledger) e 17 `WITH CHECK (true)` (15 `service_role` + os 2 de B09, criados em `20260627180000`/`20260708171049`); "0 SECDEF sem `search_path`" continua verdade (249/249 têm).
Por que importa: é o arquivo que diz o que é DESENHO — um auditor novo lê "todos os WITH CHECK(true) são service_role" e para de olhar.
Proposta: gerar a seção de contagens a partir do snapshot (`scripts/schema-security-counts.ts`, chamado pelo `refresh-snapshot.sh`) e registrar B09 como decisão (manter/apertar).
I=2 · R=1 · E=1

---

## Medições

| Eixo | Número |
|---|---|
| Snapshot | 51.692 linhas · commit `1851416fc` 2026-09-05 por `gpt-engineer-app[bot]` · pg_dump 17.9 · manifest diz 50.880 / 2026-08-28 |
| Tabelas `public` | 336 · com RLS 335 (única sem: `_quarantine_omie_clientes_20260722`) · com RLS e 0 policies: 7 (`ia_uso_evento`, `ia_uso_limite`, `posthog_error_webhook_log`, `reposicao_param_limbo_log`, `sayerlack_retry_motor_log`, `sku_items_sync_controle`, `whatsapp_sla_digest_log`) · sem PK: 0 |
| Policies | 703 · `USING (true)` 30 (6 PUBLIC catálogo · 9 authenticated referência · resto service_role) · `WITH CHECK (true)` 17 (15 service_role · 2 authenticated = B09) · `has_role` 358 · `carteira_visivel_para` 8 · `auth.role()` 41 · `auth.uid() IS NOT NULL` puro 1 |
| Views | 81 (+5 matviews) · `security_invoker` on/true 75 · off/false 6 (`selfservice_*` ×3, `customer_metrics_mv`, `inventory_position_operacional`, `v_oportunidade_economica_hoje_badge_cached` — todas desenho documentado, #1246/`20260708190000`/`20260717120000`) · sem opção: 0 |
| Funções | 347 public + 25 private · SECURITY DEFINER 249 · SECDEF sem `SET search_path`: 0 · sufixo versionado: 0 (`limpar_sugestoes_antigas` é falso positivo) · órfãs: 12 (4 SECDEF, 4 sem migration) · `.rpc()` distintos no código: 123 · `rpc(… as never)` em src: 34 (1 inexistente = B03) |
| Índices | 340 + 54 unique · FKs 204 · FKs sem índice na 1ª coluna 116 (26 CASCADE · 17 SET NULL · 73 NO ACTION · 26 → `auth.users`) · duplicatas exatas 7 · prefixo redundante 11 |
| Tipos | `numeric` 537 · `double precision` 8 (todas geo: `cep_geo`, `municipio_geo`, `radar_*`) · `real`/`money` 0 · `timestamp without time zone` 0 (631 com TZ) · `jsonb` 129 · `status text` 62 (24 sem CHECK/enum) · enums 14 · CHECK inline 351 |
| Cron (repo) | 170 `cron.schedule` em 63 migrations · 97 jobs · 96 vivos por histórico · 56 http (56 com `timeout_milliseconds`) + 40 SQL · 0 alvos sem edge · runbook: "33 crons" em 24/05 |
| Migrations | 682 (178 UUID + 504 custom) · por mês: fev 50 · mar 35 · abr 33 · mai 201 · jun 175 · jul 135 · ago 53 · `DROP FUNCTION` em 21 arquivos, 7 sem REVOKE, 4 recriando SECDEF (3 são drop puro; 1 tem gate interno) · 10 mais recentes: objetos presentes no snapshot (2 são DML puro) |
| Audit de migrations | `.sql` 4.460 linhas / 268 commits · `.md` 268 commits · `.ts` 8 commits · inventário 504 migrations / 1.727 objetos · resultado de prod commitado: nenhum |
| Deriva prod→repo | tabelas sem CREATE 72/336 · funções 59/345 · views 39/86 · policies (por nome) 0 |
| `db/` | 340 arquivos · `test-*.sh` 270 (84.474 linhas; 100 jun · 112 jul · 56 ago · 2 set) · `audit-*.ts` 5 · `.sql` 53 · citados por script/manifesto 14 · rodando no CI 0 (por desenho) · `initdb` inline 267 · `safeupdate` 1 · one-shots datados 4 (todos referenciados por harness/doc — não são lixo) |
| Carimbo authz | `db/authz-carimbo-prod.json` medido 2026-08-29 · 5 audits · 43 funções na allowlist · achados: 0 |

---

## Descartei porque…

1. **7 tabelas com RLS e zero policy** — é deny-all para `anon`/`authenticated` (fail-closed); todas são log/controle escritas por SECDEF/`service_role` (aparecem em 4-11 funções do snapshot) e `src/` não lê nenhuma (0 `.from()`); `sku_items_sync_controle` só numa edge (service_role). Não é dívida.
2. **6 views com `security_invoker=off/false`** — desenho documentado e provado (`20260708190000_fechar_views_invoker_off_p0.sql:30` "invoker=off dela é DELIBERADO"; `20260717120000` gate staff em `customer_metrics_mv`; `selfservice_*` é o view-gate do CLAUDE.md).
3. **SECDEF sem `search_path`, monetário em float, timestamp sem TZ, tabela sem PK, cron http sem timeout, cron apontando para edge inexistente** — todos medidos em **0** no snapshot atual (os 17 arquivos de migration com `http_post` sem timeout foram superados por re-agendamentos posteriores).
4. **`DROP FUNCTION` sem REVOKE (7 arquivos)** — 3 são drop puro (`calcular_gatilhos_reposicao`, `import_tint_formulas`, `drop_*`), 1 é a baseline UUID de maio (`has_role`/`get_user_role`, helpers que DEVEM ser executáveis por authenticated), 1 recria `fin_consolidado_intercompany` com gate interno (`fin_user_can_access`/42501). O ACL vivo das funções sensíveis é atestado pelo carimbo (43 na allowlist, 0 achados em 08-29).
5. **RPC `envio_portal_itens_mapeados` inexistente** (edge `enviar-pedido-portal-sayerlack:1685`) — ramo de fallback documentado no próprio teste (`qtde-portal.test.ts:56` "hoje inexistente em prod"). Diferente de B03, que é o caminho principal de um botão.
6. **`omie_products.metadata` jsonb com 7 edges + 4 hooks escrevendo** — a regra do CLAUDE.md proíbe SINAL money-path em jsonb multi-writer; no grep dos writers a única chave identificável é `tipo`; não encontrei cmc/preço/estoque sendo gravados ali. Sem evidência de violação — vale re-medir com `metadata ? 'chave'` via psql-ro se alguém suspeitar.
7. **Pendências já conhecidas e abertas (não repropus):** triagem das 27→24 funções em DERIVA (feita em `deriva-de-corpo-prod-a-frente-do-repo.md`; B02 ataca o MECANISMO, não a lista) e o vocabulário morto de `commercial_role` (8 valores, `rls-viva…` §11.4 item 3 — decisão de produto pendente).
8. **`prod-*`/`prereq-*`/`pcp-f1a-*` datados em `db/`** — só 4+2 arquivos, todos referenciados por harness ou doc (1-10 refs); não são candidatos a arquivamento hoje.

## Incertezas declaradas

- ACL/GRANT de qualquer objeto: invisível no dump `--no-privileges` — B04 e B10 dependem de 1 query via psql-ro para virar "achado confirmado" ou "descartado".
- "Órfã" em B04 = sem consumidor no REPO e no PRÓPRIO SNAPSHOT; consumidores externos (Zapier/n8n/BI) só aparecem em `pg_stat_user_functions`.
- Tamanho de tabelas para priorizar B05/B06: não medido (sem banco); usei os números documentados (`tint_formula_itens` 3,4M) e a natureza de staging.
