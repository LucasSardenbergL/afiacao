# Diagnóstico de banco — lote 5 do plano v9 (B4, B5, D15 e o delta de 24 h)

> **Só leitura.** Nenhuma escrita em prod; nenhum código de produto mudou. Leituras por `~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -f <arq>` com `SELECT '#FIM-OK'` no fim: todas saíram com **exit 0 e o marcador**.
> Especificação: linhas B4, B5 e D15, §1, §4 e "A instância Mini" do [plano v9](../superpowers/plans/2026-11-11-plano-melhoria-v9/README.md); parecer do Codex em [anexos/codex-contestacao.md](../superpowers/plans/2026-11-11-plano-melhoria-v9/anexos/codex-contestacao.md).
> Scripts, saídas cruas e a calculadora do delta: [dados/banco-lote5-v9/](dados/banco-lote5-v9/). Banco: PostgreSQL 17.6, `shared_buffers` 256 MB, `track_io_timing` off, no ar desde 31/10 10:33 UTC.

## 0. Resumo

| Item | Veredito | Em uma linha |
|---|---|---|
| **§1 delta** | ✅ **T0 e T1 lidos** | Janela **11/11 17:20:24 → 14/11 00:49:42 UTC = 55,5 h** (a T1 foi lida depois do prazo: são **2 ciclos diários completos**, não 24 h). **12,5 GiB/dia** de blocos lidos fora do `shared_buffers` (533 MiB/h; hit 99,45%), **55% de `tint_*`**, 15% de `radar_*`. Nenhum job falhou nem estourou timeout na janela. É 2,3× a extrapolação da janela limpa (5,5 GiB/dia) e ~74% abaixo dos 48 GiB/dia pré-R2. Detalhe na §5 |
| **B4** índices da lista do Radar | **Recriar com `NULLS LAST`; não dropar** | O desencontro é a causa: o mesmo SELECT na ordem do índice vira `Index Scan` (custo 11 e 24 contra ~110 e ~103 mil). Sem o conserto, os presets *novas* e *estabelecidas* ordenam 250–325 mil linhas por página. **Mas a T1 mostra a lista sem uso:** `idx_scan` +0 nos três índices `idx_radar_lista_*`, o `score` inclusive, em 55,5 h. Ganho condicional, **não urgente**. Roteiro pronto em [radar-indices-lista-nulls-last.md](../runbooks/radar-indices-lista-nulls-last.md) (**founder**, SQL Editor) |
| **B5** `cron.job_run_details` | **Nada a fazer** | Heap de 45 MB. Em janela calma, 0 bloco lido em 15 seq scans; **na T1 (55,5 h) foram 40.312 blocos = 138 MiB/dia = 1,1% da leitura** (+176 seq scans, 76/dia), quando as rajadas expulsam a tabela do cache. Índice **não é possível** pelo SQL Editor (o dono é `supabase_admin`). Dos 8 corpos que citam a tabela, só **1 função** a lê de verdade (`get_carteira_saude`, de uma tela) |
| **D15** promoção de catálogo do tint | **Não é problema de leitura; é ~1/3 do WAL** | 0,12 s, **0 bloco de temp relation lido ou escrito**, 0,83 MiB de WAL por promoção ⇒ 1.075 promoções na T1 ≈ 32% do WAL. O trabalho caro é a promoção de **fórmulas**: ~1,37 GiB de temp relation lidos e ~0,61 GiB escritos por run, e `tint_*` é 55% da leitura do banco |

## 1. O delta de 24 h (§1 e §4 do plano)

### O que já está gravado

[`leitura-24h.sql`](dados/banco-lote5-v9/leitura-24h.sql) lê `pg_stat_database`, `pg_stat_io` (PG17: separa cliente, autovacuum, parallel worker e **temp relation**), `pg_stat_wal`, checkpointer, `pg_statio_all_tables`, `pg_stat_all_tables` e `pg_statio_all_indexes`. **T0** em [`leitura-T0.out`](dados/banco-lote5-v9/leitura-T0.out):

| contador (cumulativo) | T0 (11/11 17:20:24 UTC) |
|---|---:|
| `blks_read` | 70.331.314 |
| `blks_hit` | 4.427.142.207 |
| `temp_bytes` / `temp_files` | 55.312.612.718 / 12.393 |
| WAL | 106.182.625 registros · 25.936.819.015 bytes |
| `pg_stat_io` temp relation (cliente) | leituras 3.345.062 · escritas 1.338.161 · evict 3.757.951 |

`pg_stat_*` não zera em restart limpo (✔ `stats_reset` vazio): o cumulativo vale como ponto de partida para o delta, nunca como taxa.

### T1 lida (14/11 00:49:42 UTC)

A T1 saiu depois do prazo de 24 h: a janela é de **55,49 h (2,31 dias)**, com os dois ciclos completos de madrugada (purge do staging às 05:23, agregado do Radar às 06:35) dos dias 12 e 13. Os números por dia dividem por 2,31. Saídas cruas: [`leitura-T1.out`](dados/banco-lote5-v9/leitura-T1.out), [`delta-T0-T1.out`](dados/banco-lote5-v9/delta-T0-T1.out) (`delta.py` com `--descontar public.radar_empresas=187022`), [`t1-extras.out`](dados/banco-lote5-v9/t1-extras.out) e [`t1-tint-tamanhos.out`](dados/banco-lote5-v9/t1-tint-tamanhos.out); todas com exit 0 e `#FIM-OK`. Resultado na §5.

### O desconto que precisa constar (erro meu)

Depois do T0, duas consultas de **diagnóstico minhas** (`count(*) … GROUP BY` em `radar_empresas`) leram o heap inteiro (93.511 páginas cada). O teste de 11 min mostrou `heap_blks_read` +187.038 na tabela, com 2 das 4 varreduras sequenciais sendo minhas. O `delta.py` desconta **187.022 blocos (~1,46 GiB)**, registrados em [`descontos.txt`](dados/banco-lote5-v9/descontos.txt); o bruto aparece junto. **Não é descontável e entra no número:** leitura de sessões-irmãs do mesmo plano (também `psql-ro`) e dos crons. Evite `count(*)` em tabela grande até a T1.

### O que o teste de 11 minutos já mostra (não é a medida de 24 h)

T0 → 17:31:40 UTC, **com o desconto**: `blks_read` +33.500 (**262 MiB** em 11 min, hit 99,82%), `temp_bytes` 0. Mesmo descontado, é bem acima dos 54 MiB em 19 min da janela limpa do plano: a diferença vem de `sales_orders` (77 MiB), `acoes_execucoes` (22 MiB), `fin_sync_log`, `fin_contas_pagar` etc., ou seja, **consulta de outras sessões e crons**, não do Radar (`radar_contatos` 0). Foi um lembrete de que a janela "limpa" do plano era limpa **de propósito**, e o dia não é.

## 2. B4 — índices `idx_radar_lista_estab` e `idx_radar_lista_novas`

**Corpo vivo** (`pg_get_functiondef` de `radar_lista`, 23 argumentos, md5 do `prosrc` `829e547135cecdd67d7af0c9c777a99f`): o SELECT final é `SELECT e.* FROM radar_empresas e WHERE … ORDER BY e.<col> DESC NULLS LAST, e.cnpj LIMIT $17 OFFSET $18`, com `<col>` em (`score`, `capital_social`, `data_abertura`), idêntico ao da migration `20261111120000:545`. Os presets da tela (`presetParaParams`, `src/lib/radar/ui-helpers.ts`): *score*, *estabelecidas* (`capital_social` + `data_abertura <= hoje − 5 anos`) e *novas* (`data_abertura`).

**Os índices** (✔ `pg_get_indexdef`): `idx_radar_lista_estab (capital_social DESC, cnpj)` **61.071.360 B, 0 scans**; `idx_radar_lista_novas (data_abertura DESC, cnpj)` **45.252.608 B, 2 scans**; os dois parciais `WHERE ja_cliente = false AND prospeccao_status <> 'descartado'` (o mesmo predicado da base da lista). O irmão `idx_radar_lista_score (score DESC NULLS LAST, cnpj)`: 59.678.720 B, **146 scans**. Criados em 13/06 (#803, "sort de 526k → index-scan"); a única outra migration que os cita é a do `idx_radar_lista_score`. **Correção ao parecer do Codex:** a `20261111150000` recria só os dois `titular_mei`, **não** os `idx_radar_lista_*` (`git grep idx_radar_lista -- supabase/migrations`: só `20260613210000` e `20261019180000`), então os 0 e 2 scans **não** são de objeto recém-criado.

**`EXPLAIN` (sem ANALYZE) dos SELECTs internos**, parâmetros reais da tela: lote vigente `2026-10` (✔ `radar_ingest_state`: `complete`/`publicada`, nenhuma publicação em curso ⇒ `$21` NULL), base `a_contatar` e não-cliente. Saída crua: [`b4-explain.out`](dados/banco-lote5-v9/b4-explain.out).

| caso | plano escolhido | custo total |
|---|---|---:|
| A score (controle), lote vigente | `Index Scan idx_radar_lista_score`, sem Sort | 15,88 |
| B estabelecidas, lote vigente | `Parallel Index Scan idx_radar_empresas_fila` + **Sort** (125 mil linhas) | 99.597 |
| C novas, lote vigente | **Parallel Seq Scan** do heap + **Sort** (254 mil linhas) | 110.326 |
| D estabelecidas, sem lote | `idx_radar_empresas_fila` + **Sort** (161 mil) | 102.860 |
| E novas, sem lote | **Seq Scan** + **Sort** (325 mil) | 109.963 |
| F novas, UF = SP | bitmap de 2 índices + **Sort** (75 mil) | 89.967 |
| **G** novas, **na ordem do índice** (`DESC`, sem `NULLS LAST`) | `Index Scan idx_radar_lista_novas`, sem Sort | **11,41** |
| **H** estabelecidas, **na ordem do índice** | `Index Scan idx_radar_lista_estab`, sem Sort | **24,44** |
| I estabelecidas, offset 1000 | como D | 106.480 |

G e H são o contrafactual que o Codex pediu: **o mesmo SELECT, só trocando a ordenação para a do índice, passa a usá-lo**. Logo os índices não estão mortos por inutilidade; estão **mortos por não casar** (`DESC` é `NULLS FIRST`; a lista pede `NULLS LAST`, e o planejador não assume NOT NULL porque `capital_social` e `data_abertura` aceitam nulo, embora `pg_stats.null_frac` seja 0 nas duas).

**Consequência:** cada página do preset *novas* lê o heap inteiro da `radar_empresas` (**93.511 páginas, 731 MB**; a tabela com índices tem 1.427 MB) e ordena 250–325 mil linhas de 808 bytes. O preset *estabelecidas* ordena 125–160 mil. A RPC nasceu em 03/11 (migration `20261103131500`, citada em `useRadarLista.ts`); antes a lista lia pelo PostgREST.

**Veredito: recriar com `NULLS LAST`, não dropar.** Dropar tira ~101 MB de disco (não é memória: o parecer do Codex vale) mas deixa os dois presets lendo 731 MB por página. O custo de manter é escrita em cada carga mensal (o mesmo de hoje, porque os índices já existem). **Quanto isso pesa de verdade depende de quanto os presets são usados**, e isso só se vê no delta de 24 h (`radar_empresas` `seq_scan` e `idx_scan` dos três índices, no `delta.py`); com 1 usuário nos sensores, pode ser pouco. **A T1 respondeu: não há uso.** Em 55,5 h o `idx_scan` ficou em **+0 nos três** `idx_radar_lista_*` (o `score`, que casa com a query, inclusive): a lista do Radar não foi exercida na janela. Os `seq_scan` de `radar_empresas` (+8, 2 deles meus) vêm de outros leitores, não dos presets. Por isso o conserto é de **baixo risco e ganho condicional**, **não urgente**. Não medi o tempo real (`ANALYZE` leria 731 MB e sujaria a T1); se o founder quiser o número, rodar **depois** da T1.

**Roteiro:** [`docs/runbooks/radar-indices-lista-nulls-last.md`](../runbooks/radar-indices-lista-nulls-last.md): pré-voo, `CREATE INDEX CONCURRENTLY` com nome novo (`_nl`), prova de que o plano usa o índice sem `Sort`, só então `DROP INDEX CONCURRENTLY` do antigo e `RENAME`; reversão. Um bloco por execução (`CONCURRENTLY` não roda em transação). **Não aplicado.**

## 3. B5 — `cron.job_run_details`

✔ **Tamanho e conteúdo:** heap 45 MB (5.723 páginas), 49 MB com o índice `job_run_details_pkey (runid)`; 127.850 linhas de 04/11 04:00 a 11/11 17:26 UTC; **68%** são dos dois ticks de 15 s (jobs 245 e 187: 43.479 + 43.283). Retenção: job 137 `purge-cron-job-run-details`, `0 4 * * *`, `DELETE … < now() - interval '7 days'`; 6 autovacuums, o último em 11/11 04:01, `n_dead_tup` 0.

**Ownership:** ✔ o schema `cron` e a tabela são de **`supabase_admin`**. O `postgres` tem privilégios de tabela (`arwdDxtm` com grant option) e `USAGE` no schema, mas **`has_schema_privilege('postgres','cron','CREATE')` = false** e `pg_has_role('postgres','supabase_admin','USAGE')` = false. `CREATE INDEX` exige ser dono da tabela: **dedução do catálogo, não tentada** (não escrevo em prod), mas o SQL Editor, que roda como `postgres`, não cria índice ali. Um índice `(jobid, start_time)` não é opção do founder.

**Leitores nos corpos vivos** (`prosrc ILIKE '%job_run_details%'`, 8 funções + 2 views; saída em [`b5-leitores.out`](dados/banco-lote5-v9/b5-leitores.out), linhas em [`b5-corpos.out`](dados/banco-lote5-v9/b5-corpos.out)):

| objeto | lê de verdade? |
|---|---|
| `get_carteira_saude()` | **Sim.** 4 `LEFT JOIN LATERAL (… WHERE d.jobid = j.jobid ORDER BY d.start_time DESC LIMIT 1)`: sem índice em `jobid`, **4 varreduras da tabela por chamada**. Chamada por `useCarteiraSaude` (`staleTime` 60 s) no `CarteiraSaudePanel`, só em `AdminAnalyticsSync` |
| `v_cron_jobs_status` | **Sim**, 2 varreduras por consulta (`DISTINCT ON` de 30 d e agregado de 7 d), filtrada por `jobname LIKE 'afiacao_%'` |
| `v_cron_jobs_falhas` | **Sim**, 1 varredura, mesmo filtro. **Nenhuma das duas views tem chamador** em `src/`, `supabase/functions`, `pg_proc` ou `cron.job` (só aparecem em `types.ts`) |
| `_data_health_compute()` | **Não**: as 5 linhas são comentário ou texto de mensagem (`'… leia cron.job_run_details'`). Confirma o Codex |
| `tint_watchdog_corante_check`, `…_vigia_check`, `tint_promocao_watchdog` | **Não**: comentário ou mensagem. Confirma o Codex (leem `sync_state`) |
| `analytics_outbox_claim`, `radar_avisar_vendedores` (cron 273 inativo) | **Não**: comentário |
| `extensions.grant_pg_cron_access` | concede acesso, não lê |

**Medido:** amostra do contador a cada 5 s por 11,7 min ([`b5-amostra-seqscan.out`](dados/banco-lote5-v9/b5-amostra-seqscan.out)): `seq_scan` 1629 → 1644 (**+15**), `seq_tup_read` +1,8 M, `idx_scan` +0 e, no teste de 11 min da §1, **`heap_blks_read` +0 e 85.850 hits**. As varreduras **não** acompanham o marco dos crons de 5 min (nenhuma em :35:00; o último incremento antes é :34:11 e o seguinte :36:11), o que é coerente com o código: os watchdogs não leem a tabela. A amostra não cobre o marco de 30 min (:00/:30) nem o de 10 e 15 min de forma conclusiva. Caem em pares com ~10 s de intervalo, fora de padrão de cron. **Quem faz as outras não foi identificado:** `claude_ro` não vê `pg_stat_statements` (`extensions` negado) nem a `query` de outras sessões, e eu mesmo fiz ≥ 4 delas nesta sessão. A suspeita é de `psql-ro` de sessões-irmãs; é suspeita, não achado.

**Leitura do número do plano, com a T1:** os "1.563 seq scans e 744 mil blocos lidos (5,7 GiB)" são acumulado de ≥ 11 dias. Na janela calma (15 varreduras) a tabela esteve toda em cache (reads 0). **Na T1 de 55,5 h não foi zero**: `heap_blks_read` **+40.312** (315 MiB, **138 MiB/dia**), `seq_scan` **+176** (76/dia), `seq_tup_read` +23 M, `idx_scan` +0 e `n_tup_del` +32.265 (o purge diário). São **1,1%** da leitura do banco (0,5 GiB/dia do plano era a ordem de grandeza errada: o real é 0,13 GiB/dia). A tabela só vai ao disco quando uma rajada (promoção de fórmulas, staging) expulsa ela do `shared_buffers`.

**Veredito: nada a fazer** (1,1% da leitura, e índice não é opção do founder). Opções, se um dia pesar: (a) encurtar a retenção dos dois ticks de 15 s via `cron.alter_job` do job 137 (o job é do `postgres`; `DELETE` sem `VACUUM` não encolhe o arquivo, mas reduz as linhas varridas e o autovacuum de hoje já roda diariamente); (b) trocar o LATERAL de `get_carteira_saude` por um único `DISTINCT ON`: 4 varreduras viram 1, mas é função de tela de baixo uso. Nenhuma justificada pelo número da T1.

## 4. D15 — as 22 tabelas temporárias da promoção do tint

**Money-path (preço do tintométrico): nada foi refatorado, nem rodei o promote.** Só contadores, mais o ledger que o próprio sistema já grava.

✔ **O corpo vivo** de `tint_promote_sync_run(uuid)` (md5 `bbd219afff819b3d2401f8e33a8a4010`) tem **22** `CREATE TEMP TABLE … ON COMMIT DROP` (o plano contou 21): `_tp_prod`, `_tp_base`, `_tp_emb`, `_tp_cor`, `_tp_sku`, `_skus_novos`, `_pares`, `_formulas_latest`, `_fl_resolved`, `_fl_culpa`, `_fl_corrompida`, `_expand`, `_preco`, `_expand_uniq`, `_eu_incompleta`, `_eu_pura_contraditoria`, `_eu_sem_receita`, `_eu_limpezas`, `_snap_fonte`, `_pulados`, `_promoted`, `_assinar`. É chamada por `tint_promocao_tick` (job 187, a cada 15 s).

**Duração real** = duração do tick de cron que contém o `promovido_em` do run (7 d; [`d15-duracao.out`](dados/banco-lote5-v9/d15-duracao.out)):

| classe | ticks | p50 | p90 | p99 | máx | soma |
|---|---:|---:|---:|---:|---:|---:|
| ocioso | 36.197 | 0,007 s | 0,008 s | 0,036 s | 33,0 s | 382 s |
| **promoção de `catalogs`** | 3.885 | **0,123 s** | 0,340 s | 0,682 s | 7,5 s | 691 s |
| **promoção de `formulas`** | **10** | **323 s** | 412 s | 462 s | 468 s | 2.626 s |

(O `promovido_em − completed_at` do plano, 34 s no p50, é espera pelo tick de 15 s, não execução.) Volume: 185 a 695 promoções de `catalogs` por dia (média ~555 em 7 d); `formulas` ~2 por dia (10 em 7 d), cada uma com ~490 mil inserts.

**Uma promoção de `catalogs` representativa**, medida em 10 promoções reais em 2 rajadas (17:34:39–17:35:40 e 17:45:40–17:45:55; série de 3 s em [`d15-amostra.out`](dados/banco-lote5-v9/d15-amostra.out), agrupada por `d15-rajadas.py`; `pg_class` +570 = 10 × 57 exatos), descontando o ritmo basal das janelas quietas (969 s, 0,0061 MiB/s de WAL):

| por promoção | valor |
|---|---:|
| temp relation (buffers locais): leituras / escritas / evict | **0 / 0 / 0** (16 hits e 12 extends nas 10) |
| `temp_bytes` (sort/hash em arquivo) | 0 nas duas rajadas |
| **WAL líquido** | **0,83 MiB** |
| linhas de catálogo inseridas **e** apagadas | `pg_attribute` 432 · `pg_depend` 117 · `pg_class` 57 · `pg_type` 42 · `pg_index` 18 (**666 + 666**) |
| transações | ~19 |
| duração | 0,12 s (p50) |

Extrapolando: ~555 promoções/dia ≈ **~460 MiB/dia de WAL** e ~370 mil linhas de catálogo criadas e apagadas. Os catálogos seguem pequenos e saudáveis (✔ [`d15-catalogo.out`](dados/banco-lote5-v9/d15-catalogo.out): `pg_attribute` 3,3 MB, 508 autovacuums; `pg_depend` 1,6 MB; `pg_class` 1,2 MB; `temp_buffers` 8 MB). Na T1: **1.075 promoções de `catalogs` × 0,83 MiB ≈ 892 MiB de 2.789 MiB de WAL = ~32% do WAL da janela** (1.206 MiB/dia no total).

**Veredito:** o diagnóstico que o Codex reabriu (buffers locais) **fecha negativo para `catalogs`**: as temporárias são minúsculas, **não geram IO local**, a promoção leva 0,12 s, e o custo é só metadado e ~0,8 MiB de WAL. Não justifica refatorar (menos ainda em money-path). **O trabalho caro é a promoção de `formulas`** (323 s no p50, 2 por dia, lendo o staging de ~590 MB). Na T1 houve **3 promoções de fórmulas** (12/11 10:05, 13/11 10:09 e 11:21) e 1.075 de `catalogs` (que gastam ~0 de temp relation). O `pg_stat_io` de temp relation na janela: **526.494 leituras (4.113 MiB) e 234.012 escritas (1.828 MiB)**, ou seja, **~1,37 GiB lidos e ~0,61 GiB escritos por promoção de fórmulas**, assumindo que toda temp relation da janela é do tint (não há outro gerador conhecido; não separei). `temp_bytes` (sort/hash em arquivo): 2,5 GB na janela, 581 arquivos. As tabelas `tint_*` somaram **16,2 GiB = 55%** da leitura, e o `tint_staging_*` sozinho 5,8 GiB: o T2 (`VACUUM FULL` do staging, founder) continua sendo o remédio já proposto para esse pedaço.

## 5. Resultado da T1 e a decisão sobre a instância Mini

**Janela:** 11/11 17:20:24 → 14/11 00:49:42 UTC = **55,49 h**. Bruto 3.976.031 blocos; descontados 187.022 (minhas duas consultas em `radar_empresas`); **líquido 3.789.009 blocos = 29.602 MiB = 533 MiB/h = 12.803 MiB/dia (12,5 GiB/dia)**. `blks_hit` 679,6 M, **hit 99,446%**. Atenção ao denominador: é uma janela de 2,3 dias, com 3 runs de fórmulas (o normal são ~2 por dia: 12/11 à tarde não teve).

| de onde vem a leitura (líquido) | MiB na janela | % | MiB/dia |
|---|---:|---:|---:|
| `tint_*` (promoção, staging, sync_runs, errors) | 16.189 | 54,6% | 7.002 |
| `radar_*` | 4.580 | 15,5% | 1.981 |
| `sales_orders` (2.320 seq scans) | 1.684 | 5,7% | 728 |
| catálogos `pg_catalog` | 1.487 | 5,0% | 643 |
| `net._http_response` | 507 | 1,7% | 219 |
| `cron.job_run_details` | 321 | 1,1% | 139 |

Top 15 por tabela: `tint_formulas` 4.278 MiB, `radar_empresas` 3.141 (descontado), `tint_formula_itens` 3.088, `tint_staging_formulas` 2.926, `sales_orders` 1.684, `tint_staging_formula_itens` 1.481, **`tint_sync_runs` 1.451**, `tint_staging_skus` 1.401, `radar_contatos` 1.042, `tint_sync_errors` 661, `net._http_response` 506, `fin_movimentacoes` 452, `pg_class` 418, `venda_items_history` 384, `venda_sugestao` 363. `radar_contatos`: 451 MiB/dia (o 19,6 MiB por rodada de expurgo × 24, como o plano previa). **Novo, fora do escopo:** `tint_sync_runs` tem **87 MB** e leu 1,45 GiB (~17 leituras do heap inteiro, 1,38 M `idx_scan`, 113.784 deletes): candidato a diagnóstico próprio, não investigado aqui.

Outros contadores da janela: `temp_bytes` **1.041 MiB/dia** (2,5 GB, 581 arquivos); WAL **1.206 MiB/dia** (50 MiB/h; 12,8 M registros, 703 mil FPI); checkpointer 663 por tempo e 3 por demanda. `pg_stat_io` do cliente: `relation` normal 20,3 GiB, `bulkread` (seq scan) 6,7 GiB, temp relation 4,1 GiB lidos. **Jobs com falha ou timeout na janela: nenhum** (consulta a `cron.job_run_details` por `status <> 'succeeded'` voltou vazia, com exit 0 e `#FIM-OK`). O tick de promoção (job 187) gastou 799 s em 13.267 execuções, o mais longo com 309 s.

**O que isso diz sobre os números do plano:** o plano extrapolou ~5,5 GiB/dia da janela limpa de 19 min; o dia inteiro leu **12,5 GiB/dia, 2,3× mais**, porque a janela limpa excluía justamente as rajadas do tint e do Radar (o Codex avisou). Contra os 48 GiB/dia de antes do R2, a leitura caiu ~74%. Mais da metade é o tint, não o Radar.

Critério do v7 (a decisão é do founder): aviso de "high load", horas destacadas nos cards de CPU, Memory ou Disk, ou job falhando por timeout ⇒ **(a) Small**; nada disso ⇒ **(c) aceitar**. O delta de 24 h é evidência de carga de leitura, **não substitui** os cards do painel do Lovable. Bloco lido fora do `shared_buffers` também não é IO físico (cache do SO), e `track_io_timing` está off: sem tempo de IO medido, "MiB lidos" é teto, não latência.

## 6. O que não foi feito

- Não rodei `EXPLAIN ANALYZE` (leria 731 MB e contaminaria a T1) nem chamei função que grava.
- Não criei índice no schema `cron` (a negativa vem do catálogo).
- Não identifiquei as sessões que leem `cron.job_run_details` fora de cron.
- A atribuição da temp relation às promoções de fórmulas é por exclusão (não há outro gerador conhecido), não por medida direta por run.
- A T1 foi lida 55,5 h depois do T0, não 24 h; as taxas por dia dividem por 2,31 e não separam dia útil de fim de semana (a janela vai de quarta 17:20 a sábado 00:49 UTC, e inclui a sexta inteira).
- Não investiguei o `tint_sync_runs` (1,45 GiB lidos numa tabela de 87 MB).
