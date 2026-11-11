# Retenção de 60 dias, semanal, nos scores do farmer (plano v4, lote 11 — item B1)

**2026-11-02.** Migration `supabase/migrations/20261102183000_retencao_scores_60d_semanal.sql`, prova
`db/test-retencao-scores-60d.sh` (PG17, 26 asserts, 3 falsificações, no núcleo do CI). Sucede a
`20261011120400` (M-17, 90 dias, mensal).

## O que entrou

- `private.expurgar_scores_antigos(p_dias=60, p_lote=10000)`: mesma assinatura (sem DROP, o ACL fica),
  com teto de 60 lotes por tabela por chamada (≤ 600k linhas) e `resta_health`/`resta_priority` no
  retorno quando o teto para a chamada com lote cheio.
- cron `expurgo-scores-farmer` de mensal (`30 4 1 * *`) para semanal (`30 4 * * 0`, domingo 04:30 UTC),
  com `statement_timeout 5min` e `lock_timeout 5s` no comando.

## Medido antes (psql-ro, 2026-11-02 17:00 UTC)

| | `health_score_history` | `priority_score_log` |
|---|---|---|
| tamanho total (heap + índices) | 434 MB (224 + 210) | 375 MB (210 + 165) |
| linhas | 1.247.917 | 1.247.917 |
| mais antiga | 2026-08-03 | 2026-08-03 |
| ritmo (últimos 30 d) | ~14,2k/dia | ~14,2k/dia |
| > 60 dias (o que o 1º domingo leva) | 424.512 | 411.246 |

O run mensal de 1º/11 apagou 607.460 linhas por tabela em 37 s (`cron.job_run_details` 820121).

Leitores instalados em prod: nenhum além do próprio expurgo (varredura de `pg_proc.prosrc`, `pg_views`,
`pg_matviews`, triggers e FKs de entrada). No repo, só o INSERT da edge `calculate-scores`
(`index.ts:1112`) e comentários.

## Espaço por opção

Densidade medida: 457 B por par de linhas (809 MB para as 1.855.377 linhas que as tabelas tinham antes
do run de 1º/11), dos quais 118 B são os 4 índices (customer|farmer, data) sem scan. Pico = horizonte
mais os 7 dias entre dois expurgos.

| Opção | Pico de linhas por tabela | Dados vivos | Sem os 4 índices |
|---|---|---|---|
| 30 d semanal | 525k | 229 MB | 170 MB |
| **60 d semanal (escolhida)** | 950k | 414 MB | 307 MB |
| 90 d semanal | 1.376k | 600 MB | 445 MB |
| 90 d mensal (antes) | 1.716k | 748 MB | 555 MB |

O DELETE não encolhe o arquivo: o espaço volta para REUSO pelo autovacuum e a tabela para de crescer.
Os 809 MB só caem com `VACUUM FULL` (lock exclusivo, reescreve a tabela) ou com o DROP dos índices.

## Por que o teto

Antes, a função apagava tudo numa chamada. Se o atraso passasse do `statement_timeout`, a chamada
inteira voltaria atrás toda semana sem apagar nada. Com o teto, cada chamada avança. O DELETE pega
`RowExclusiveLock`, que não conflita com o INSERT da `calculate-scores`, e só toca linha velha que
ninguém atualiza. O que o teto limita é a duração da transação (o horizonte do vacuum do banco todo).

## Os 4 índices sem scan

`idx_health_history_customer` 104 MB, `idx_health_history_farmer` 24 MB, `idx_priority_log_customer`
65 MB, `idx_priority_log_farmer_date` 16 MB: 0 scans desde o restart de 2026-10-31 10:33 UTC
(`stats_reset` nulo, então o contador vale desde o boot). A janela de 7 dias fecha em
**2026-11-07 10:33 UTC**. Conferência:

```sql
SELECT pg_postmaster_start_time() AS boot, now() - pg_postmaster_start_time() AS janela,
       indexrelname, idx_scan, last_idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho
  FROM pg_stat_user_indexes
 WHERE relname IN ('health_score_history', 'priority_score_log')
 ORDER BY indexrelname;
```

DROP só se `janela ≥ 7 days` e `idx_scan = 0` nos 4. Se houver restart no meio, a janela recomeça.
`DROP INDEX` é DDL destrutivo, então vai pelo founder no SQL Editor, com pós-condição.

**2026-11-06: DROP antecipado em 14 h, por decisão do founder.** Às 20:55 UTC, com 6 d 10 h de contador,
os 4 seguiam com 0 scan e nenhuma constraint dependente. A janela já cobria o escritor diário, o expurgo
de 1º/11 e todos os dias da semana; como ninguém lê as tabelas, as 14 h restantes não traziam informação.
Migration `supabase/migrations/20261106205556_drop_indices_ociosos_scores.sql` (SQL Editor, o arquivo traz
a transação). A PRE aborta se algum índice ganhou scan, e a pós-condição exige os 4 fora e PKs + índices
por data válidos. Prova `db/test-drop-indices-scores.sh` (PG17, 12 asserts, 2 falsificações, no núcleo do
CI). Ganho: ~211 MB. A reversão (4 `CREATE INDEX`) está no cabeçalho da migration. Tirado do escopo da
sessão `v5-d5-b1-indices` (plano v7, D5), que segue com os índices do Radar e do tintométrico.

**2026-11-07 12:32 UTC: DROP validado por fora** (`psql-ro`, exit 0, marcador `FIM-OK`). Boot
`2026-10-31 10:33:02 UTC`, `stats_reset` nulo, janela 7 d 01:59. Os 4 têm `to_regclass` nulo. Ficaram
`health_score_history_pkey` 30 scans, `idx_health_history_calculated_at` 25, `idx_priority_log_score_date` 30 e
`priority_score_log_pkey` 30. Índices das tabelas: 84 MB e 85 MB.

## Os outros índices com 0 scans (plano v7, D5): reler, não dropar

Conferência de 2026-11-07 12:32 UTC, mesma janela de 7 d 01:59:

| índice | tamanho | scans | veredito |
|---|---|---|---|
| `idx_radar_muni_cover` | 150 MB | — | já caiu pelo #3639 |
| `idx_radar_empresas_titular_mei` | 17 MB | 3.696 | em uso (era 0 em 05/11, com 1 dia de vida) |
| `idx_radar_empresas_tel2` | 1,5 MB | 4.258 | em uso |
| `idx_radar_lista_novas` | 43 MB | 0 | **manter; reler depois do lote 2026-11** |
| `idx_radar_lista_estab` | 58 MB | 0 | **manter; reler depois do lote 2026-11** |
| `idx_tint_formulas_nome_cor` | 81 MB | 0 | **inalcançável pelos leitores de hoje; DROP ou busca indexável fica com o founder** |

**`lista_novas`/`lista_estab`: 0 scans quer dizer "superado", mais do que "raro".** Os presets "Novas" e
"Estabelecidas" existem (`src/lib/radar/ui-helpers.ts`, `RadarFiltros.tsx`), mas a `radar_lista` monta
`ORDER BY e.<col> DESC NULLS LAST, e.cnpj`, e os dois índices são `(<col> DESC, cnpj)`, que é `NULLS FIRST`.
O irmão `idx_radar_lista_score` é `DESC NULLS LAST` e tem uso (86 scans). Com a ordem que a RPC gera, o planner
lê o índice inteiro e ordena; com `DESC` puro, para em 50 linhas. Medido sem filtro de lote, `ja_cliente = false`
(`EXPLAIN ANALYZE`): **15,7 s** contra **2,2 ms**. Nenhuma das duas colunas tem nulo. Na tela real isso nem chega:
o padrão é `incluirJaClientes: true` (`useRadarLista.ts:42`), e aí o predicado do índice parcial não vale. O
`p_ultimo_lote` do recorte vigente leva o planner ao `idx_radar_empresas_lote_vista` mais um sort (`EXPLAIN`
de 07/11). É a mesma história do `muni_cover` (#3639): o filtro de lote tirou o papel do índice. Não decido DROP
porque o uso do Radar é mensal e a janela não pegou a chegada de lote nenhum (o vigente é `2026-10`).
**Reler depois que o lote `2026-11` entrar e for trabalhado.** Se continuar 0, o DROP dos dois (~101 MB) segue o
molde do #3639. Se alguém quiser os presets rápidos, a troca é recriar com `DESC NULLS LAST`, não criar outro.

**`idx_tint_formulas_nome_cor` (gin trigram): os 0 scans são ESTRUTURAIS.** Os dois leitores, a busca global do
Cmd-K (`src/hooks/useGlobalSearch.ts:112`) e a tela de fórmulas (`src/pages/TintFormulas.tsx:128`), filtram
`cor_id ILIKE '%x%' OR nome_cor ILIKE '%x%'` (`ilikeOr`). `cor_id` não tem índice trigram, e um OR com um braço
sem índice não vira BitmapOr. `EXPLAIN` de 07/11: o Cmd-K usa `idx_tint_formulas_ativas` com filtro, e a tela usa
`uq_tint_formulas_chave` com filtro. O controle, só `nome_cor ILIKE`, usa o gin (Bitmap Index Scan). Nenhuma RPC
ou edge filtra `nome_cor` por LIKE. Esperar mais não muda o número, então a decisão é de produto: (a) DROP, que
libera 81 MB e tira a manutenção do gin da escrita em ~1 M fórmulas; ou (b) tornar a busca indexável (trigram em
`cor_id` também). **Decisão do founder em 07/11: DROP (a).** Migration
`supabase/migrations/20261108120001_tint_drop_idx_nome_cor.sql` (#3713), aplicada no SQL Editor. A PRE normaliza
a opclass, porque o `postgres` tem `extensions` no `search_path` e `pg_get_indexdef` sai sem o prefixo. Prova PG17
18/18 em `C` e `pt_BR.UTF-8`, com 3 falsificações. **Validado por fora em 2026-11-07 23:43 UTC** (`psql-ro`, exit 0,
`FIM-OK`): `to_regclass` nulo, os 6 índices que ficam válidos, e os índices de `tint_formulas` passaram de 634 MB para 553 MB.

**Contaminação de medição:** o `EXPLAIN ANALYZE` acima rodou em 2026-11-07 ~12:40 UTC e somou ~520 k
buffers lidos do cache e ~39 k do disco aos contadores de `radar_empresas` (heap e índice). O D12 do v7
mediu às 12:32 UTC (#3697), antes disso, então o número dele está limpo. Um delta que atravesse essa hora
precisa descontar essa soma.

**Na releitura dos `lista_*`, desconte 2 scans.** O mesmo `EXPLAIN ANALYZE` somou 2 a `idx_radar_lista_novas`
(`last_idx_scan` 2026-11-07 12:36 UTC), e em 2026-11-10 19:55 UTC o contador estava exatamente nisso. Esses 2 não
são uso de tela. O `idx_radar_lista_estab` seguia com 0. O lote vigente ainda era `2026-10`.

## 1º expurgo semanal (2026-11-08) — medido em 2026-11-10 via psql-ro

- Job 196, run 932378: `succeeded` às 04:30, **28 s**. Ficou abaixo dos 37 s do run mensal de 1º/11 e dentro do `statement_timeout` de 5 min.
- As duas tabelas agora começam em **2026-09-09**, o corte de 60 dias do domingo. Há 1.029.013 linhas em cada uma, com zero acima de 67 dias.
- Tamanho total: 307 MB + 296 MB = 603 MB (eram 809 MB antes do DROP dos índices). O autovacuum rodou às 04:31 e o espaço apagado volta para reuso. O arquivo não encolhe, como previsto. As tabelas, porém, **não** param de crescer: o ritmo de escrita subiu 2,56× em 02/11 (achado abaixo).

## 1º expurgo semanal: a conta exata e o veredito do plano v7 (2026-11-10)

Complementa a seção anterior (#3796). Leitura em 2026-11-10 19:41 UTC (`psql-ro -v ON_ERROR_STOP=1`, rc 0,
marcador `FIM_OK`).

**Veredito: ✅ o expurgo semanal funciona como desenhado.** A 1ª passada levou todo o atraso numa chamada só, e o
teto tem folga para o ritmo novo. A premissa de espaço é que caducou: as tabelas **não** param de crescer (ver
abaixo).

| | medido |
|---|---|
| apagado por tabela | **490.842** = `n_tup_del` desde o boot (1.098.302) − o run de 1º/11 (607.460) |
| conferência | 464.310 (> 60 d em 05/11) + 2 lotes diários de 13.266 (06 e 07/09) = 490.842, exato |
| linha mais antiga depois | 2026-09-09 06:00 nas duas: o corte de 08/11 era 2026-09-09 04:30, então nada ficou para trás |
| > 60 d hoje | **39.798** por tabela = 3 lotes de 13.266 (09 a 11/09): o acúmulo normal entre domingos, não resto |

O `return_message` do pg_cron só diz `1 row`: ele não guarda o jsonb que a função devolve, então `resta_*` não
aparece ali. A prova de que o teto não cortou a chamada é a linha mais antiga depois do corte e a conta exata
acima.

### Achado: o ritmo de escrita subiu 2,56× em 02/11, e a tabela de espaço acima ficou velha

| dia | linhas/dia por tabela | clientes distintos | passadas (minutos distintos) |
|---|---|---|---|
| até 2026-11-01 | 13.266 | 6.633 | 2 |
| 2026-11-02 em diante | 33.982 a 34.078 | 16.993 a 17.039 | 3 em 02 e 03/11 |

São sempre 3 farmers. Cada cliente aparece 2× por dia nas duas tabelas, porque a `calculate-scores` grava o
universo inteiro em mais de uma passada diária. O salto coincide com o import de clientes no servidor (#3501,
mergeado em 2026-11-01 21:56 UTC) e com a varredura diária (#3535, 02/11). **Não verifiquei a causa nesta fatia.**

O que muda:

- **Teto da função:** 7 × 34k = ~238k linhas por domingo, contra 600k por chamada. Folga de 2,5×.
- **Pico de linhas por tabela** (60 d mais 7 d): de 950k para **~2,28 M**.
- **Espaço:** na densidade sem os 4 índices (307 MB para 950k), o pico vai para **~740 MB por tabela**, contra
  ~300 MB hoje. O heap absorve até o volume de antes do run de 1º/11 (~1,86 M) e cresce depois disso. O pico
  chega quando a janela de 60 d estiver toda no ritmo novo, por volta de **2027-01-01**.

**Proposta (não aplicada, decisão do founder):** a instância já está em discussão (D11: Micro → Small). Antes de
pagar ~880 MB a mais nas duas tabelas, vale responder duas perguntas de produto. Os ~10,4 k clientes novos
precisam de score diário (aliases fiscais `@placeholder.local` e cadastros sem farmer ativo entram)? A 2ª
passada diária precisa ir para o histórico, ou só a última do dia? Cada "não" corta o volume pela metade, ou mais.
Sem mudança, a retenção pode descer para 30 d: o histórico não tem leitor além do próprio expurgo.

Reler em 2026-11-15 (2º domingo), e o tamanho por volta de 2027-01-03:

```sql
SELECT runid, status, end_time - start_time AS dur, return_message
  FROM cron.job_run_details WHERE jobid = 196 ORDER BY start_time DESC LIMIT 3;
SELECT relname, n_tup_del, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS total
  FROM pg_stat_user_tables WHERE relname IN ('health_score_history', 'priority_score_log');
SELECT count(*) FILTER (WHERE calculated_at < now() - interval '60 days') AS gt60, min(calculated_at)
  FROM public.health_score_history;
```
