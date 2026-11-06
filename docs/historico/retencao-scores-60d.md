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
