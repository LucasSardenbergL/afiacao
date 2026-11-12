# Diagnóstico de banco — lote 5 do plano v9 (B4, B5, D15 e o delta de 24 h)

> **Só leitura.** Nenhuma escrita em prod; nenhum código de produto mudou. Leituras por `~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -f <arq>` com `SELECT '#FIM-OK'` no fim: todas saíram com **exit 0 e o marcador**.
> Especificação: linhas B4, B5 e D15, §1, §4 e "A instância Mini" do [plano v9](../superpowers/plans/2026-11-11-plano-melhoria-v9/README.md); parecer do Codex em [anexos/codex-contestacao.md](../superpowers/plans/2026-11-11-plano-melhoria-v9/anexos/codex-contestacao.md).
> Scripts, saídas cruas e a calculadora do delta: [dados/banco-lote5-v9/](dados/banco-lote5-v9/). Banco: PostgreSQL 17.6, `shared_buffers` 256 MB, `track_io_timing` off, no ar desde 31/10 10:33 UTC.

## 0. Resumo

| Item | Veredito | Em uma linha |
|---|---|---|
| **§1 delta de 24 h** | 🔄 **T0 gravado; falta a T1** | T0 = **11/11 17:20:24 UTC**. **A T1 sai a partir de 12/11 17:21 UTC (14:21 em Brasília).** O número que decide a instância Mini ainda não existe: sem T1 não há baseline de dia inteiro |
| **B4** índices da lista do Radar | **Recriar com `NULLS LAST`; não dropar** | O desencontro é a causa: o mesmo SELECT na ordem do índice vira `Index Scan` (custo 11 e 24 contra ~110 e ~103 mil). Sem o conserto, os presets *novas* e *estabelecidas* ordenam 250–325 mil linhas por página. Roteiro pronto em [radar-indices-lista-nulls-last.md](../runbooks/radar-indices-lista-nulls-last.md) (**founder**, SQL Editor) |
| **B5** `cron.job_run_details` | **Nada a fazer agora** | Heap de 45 MB, 100% em cache: **0 bloco lido do disco** em 15 seq scans medidos. Os 5,7 GiB acumulados são histórico. Índice **não é possível** pelo SQL Editor (o dono é `supabase_admin`). Dos 8 corpos que citam a tabela, só **1 função** a lê de verdade (`get_carteira_saude`, de uma tela) |
| **D15** promoção de catálogo do tint | **Não é problema de leitura** | 0,12 s, **0 bloco de temp relation lido ou escrito**, 0,83 MiB de WAL por promoção. O trabalho caro é a promoção de **fórmulas** (323 s no p50, 2 por dia), medida na T1 |

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

### Como fechar (quem retomar)

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/v9-diagnostico-banco-62d341/docs/historico/dados/banco-lote5-v9
~/.config/afiacao/psql-ro -q -v ON_ERROR_STOP=1 -f leitura-24h.sql > leitura-T1.out; echo exit=$?; tail -1 leitura-T1.out
python3 -I delta.py leitura-T0.out leitura-T1.out --descontar public.radar_empresas=187022
```

Depois ajuste `:t1` em [`t1-extras.sql`](dados/banco-lote5-v9/t1-extras.sql) (o `TS` do T1) e rode: dá as promoções por tipo, os runs de fórmulas e jobs com falha/timeout na janela. **Só vale com exit 0 e `#FIM-OK` nos dois.** Com a T1, preencher a §5 e responder à pergunta do Mini.

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

**Veredito: recriar com `NULLS LAST`, não dropar.** Dropar tira ~101 MB de disco (não é memória: o parecer do Codex vale) mas deixa os dois presets lendo 731 MB por página. O custo de manter é escrita em cada carga mensal (o mesmo de hoje, porque os índices já existem). **Quanto isso pesa de verdade depende de quanto os presets são usados**, e isso só se vê no delta de 24 h (`radar_empresas` `seq_scan` e `idx_scan` dos três índices, no `delta.py`); com 1 usuário nos sensores, pode ser pouco. Por isso o conserto é de **baixo risco e ganho condicional**, não urgente. Não medi o tempo real (`ANALYZE` leria 731 MB e sujaria a T1); se o founder quiser o número, rodar **depois** da T1.

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

**Leitura do número do plano:** os "1.563 seq scans e 744 mil blocos lidos (5,7 GiB)" são **acumulado de ≥ 11 dias, com cache frio nas primeiras horas após o restart de 31/10**: hoje a tabela inteira cabe e fica no cache (reads 0 contra 85.850 hits na janela medida). O custo de 15 varreduras a 5,7 mil blocos é **CPU/hit, não disco**. Os "0,5 GiB/dia" do plano **não se reproduzem agora**; a T1 confirma ou nega no dia inteiro (linha `cron.job_run_details` do `delta.py`).

**Veredito: nada a fazer agora.** Opções, só se a T1 mostrar leitura física relevante: (a) encurtar a retenção dos dois ticks de 15 s via `cron.alter_job` do job 137 (o job é do `postgres`; `DELETE` sem `VACUUM` não encolhe o arquivo, mas reduz as linhas varridas e o autovacuum de hoje já roda diariamente); (b) trocar o LATERAL de `get_carteira_saude` por um único `DISTINCT ON`: 4 varreduras viram 1, mas é função de tela de baixo uso. Nenhuma justificada por número.

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

Extrapolando: ~555 promoções/dia ≈ **~460 MiB/dia de WAL** e ~370 mil linhas de catálogo criadas e apagadas. Os catálogos seguem pequenos e saudáveis (✔ [`d15-catalogo.out`](dados/banco-lote5-v9/d15-catalogo.out): `pg_attribute` 3,3 MB, 508 autovacuums; `pg_depend` 1,6 MB; `pg_class` 1,2 MB; `temp_buffers` 8 MB). A T1 dará a fração do WAL diário que isso representa (cumulativo: 25,9 GB).

**Veredito:** o diagnóstico que o Codex reabriu (buffers locais) **fecha negativo para `catalogs`**: as temporárias são minúsculas, **não geram IO local**, a promoção leva 0,12 s, e o custo é só metadado e ~0,8 MiB de WAL. Não justifica refatorar (menos ainda em money-path). **O trabalho caro é a promoção de `formulas`** (323 s no p50, 2 por dia, lendo o staging de ~590 MB): o `pg_stat_io` de temp relation acumulou **3,3 M leituras (25,5 GiB) e 1,3 M escritas (10,2 GiB)**, que não podem vir das `catalogs`. Para atribuir a uma promoção de fórmulas, a T1 traz o delta de temp relation contra o número de runs de fórmulas da janela (`t1-extras.sql`); sem essa janela eu não invento o número por run. O staging inchado (T2/`VACUUM FULL`, founder) é o remédio já proposto para o custo de leitura dele.

## 5. Resultado da T1 e a decisão sobre a instância Mini

**⏳ Pendente.** Preencher aqui, com a saída do `delta.py` e do `t1-extras.sql` colada (exit 0, `#FIM-OK`): janela exata; `blks_read` e MiB/dia, com o bruto e o descontado; `temp_bytes`; WAL/dia; temp relation por run de fórmulas; top 15 de `pg_statio` com `radar_contatos` e `radar_empresas`; `seq_scan` de `cron.job_run_details` e `radar_empresas`; jobs com falha/timeout.

Critério do v7 (a decisão é do founder): aviso de "high load", horas destacadas nos cards de CPU, Memory ou Disk, ou job falhando por timeout ⇒ **(a) Small**; nada disso ⇒ **(c) aceitar**. O delta de 24 h é evidência de carga de leitura, **não substitui** os cards do painel do Lovable. Bloco lido fora do `shared_buffers` também não é IO físico (cache do SO), e `track_io_timing` está off: sem tempo de IO medido, "MiB lidos" é teto, não latência.

## 6. O que não foi feito

- Não rodei `EXPLAIN ANALYZE` (leria 731 MB e contaminaria a T1) nem chamei função que grava.
- Não criei índice no schema `cron` (a negativa vem do catálogo).
- Não identifiquei as sessões que leem `cron.job_run_details` fora de cron.
- A parte de WAL/temp relation **por run de fórmulas** depende da T1.
