# D6 — `data-health-watchdog` lento: diagnóstico parcial (plano v6)

**2026-11-05, só leitura (`psql-ro`).** Item D6 do plano v6 (`docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md`, §2 D). A premissa era que o watchdog ficou 4× mais lento em 5 dias e que a curva vinha de "outro check" (`fin_sync_watchdog_check`). **Esta sessão não muda código nem banco.**

## O que está provado

**1. A curva é do job 101 (`data-health-watchdog`, `SELECT public.data_health_watchdog()`, `*/30`) e segue subindo.** Médias diárias em `cron.job_run_details`, todas `succeeded`:

| dia | 30/10 | 31/10 | 01/11 | 02/11 | 03/11 | 04/11 | 05/11 (parcial) |
|---|---|---|---|---|---|---|---|
| média (s) | 1,39 | 1,82 | 3,22 | 4,62 | 4,95 | 5,67 | **6,43** |
| máx. (s) | 2,97 | 5,53 | 9,60 | 12,83 | 10,84 | 11,73 | 12,70 |

**2. A hipótese do `fin_sync_watchdog_check` está refutada.** O job 82 (`fin-sync-watchdog`, mesmo `*/30`) ficou **estável e caindo**: 0,87 s em 30/10, 0,56–0,65 s de 02/11 a 05/11.

**3. O custo intrínseco do `_data_health_compute` é ~0,23 s, e não cresce.** A função é `LANGUAGE sql STABLE SECURITY DEFINER`: 1.498 linhas, um SELECT puro de ~35 ramos. O `claude_ro` não tem EXECUTE nela, mas o `EXPLAIN (ANALYZE, BUFFERS)` do **corpo** roda numa sessão READ ONLY sem efeito colateral:

| quando | execução | planejamento | blocos lidos do disco |
|---|---|---|---|
| 09:1x SP (fora da janela do cron) | 224 ms | 20 ms | 0 (77.093 hits) |
| 09:30:03 SP (junto da rodada do cron) | 237 ms | 26 ms | 0 |

O dono é `postgres` (`rolbypassrls = t`), e nenhuma tabela do plano tem `FORCE RLS`. Logo, o `BYPASSRLS` do `claude_ro` não esconde custo de policy.

**4. A duração por rodada é bimodal, não um custo que cresce aos poucos.** Nas últimas 14 h, as rodadas variaram de **0,53 a 12,70 s**. A rodada das 09:30 de 05/11 levou **0,68 s**. As lentas aparecem também de madrugada (04:00 → 12,70 s; 01:00 → 8,53 s), então não acompanham o horário comercial.

**5. Não há cron concorrente que explique.** Em 3 dias (144 rodadas), os jobs que se sobrepõem às rodadas do 101 são todos curtos (sobreposição média ≤ 0,76 s), e a correlação da sobreposição com a duração do 101 é ≤ 0,32.

**6. As escritas do watchdog são em tabelas minúsculas:** `fin_alertas` tem 5 linhas vivas, `data_health_watchdog_estado` 1, `fornecedor_alerta` 13.

## Achados laterais (não explicam os 6 s)

- O `fin_sync_log` (24.708 linhas, ~170/dia) está com só **45% das páginas all-visible** (644 de 1.439). O `Index Only Scan` em `idx_fin_sync_log_action_status_completed` faz **11.749 heap fetches** por scan, 4 vezes no corpo, ~45 ms no total. O autovacuum não dispara porque o limiar usa `reltuples` (24 k) e há só ~850 mortas.
- Outros backends executaram o mesmo conjunto de tabelas do compute às 09:30:36, :45 e :53. É compatível com o `get_data_health` do front (inferência: sem `pg_read_all_stats` não dá para ver a query) (`useDataHealth.ts`, `refetchInterval` de 120 s por aba em primeiro plano). Dá o mesmo custo por chamada: é carga, não a causa do watchdog lento.

## O que falta: a espera de 0,3 a 12 s fica DENTRO da rodada

Com o compute a ~0,23 s, sobram de 0,3 a 12 s **dentro** do `data_health_watchdog()`, em parte das rodadas, e o `claude_ro` não enxerga onde:

- `pg_stat_statements` → `permission denied for schema extensions`;
- `pg_stat_activity` de outra sessão → `wait_event` nulo (o `claude_ro` não tem `pg_read_all_stats`);
- uma amostragem de `pg_locks` a cada 200 ms (visível sem privilégio) perdeu a janela da rodada das 09:30, e ela, de todo modo, foi rápida.

**Próximo passo, o founder no SQL Editor (só leitura):**

```sql
-- 1) custo por chamada do watchdog e do get_data_health (média, desvio, máximo)
SELECT calls, round(mean_exec_time::numeric,1) AS ms_med, round(stddev_exec_time::numeric,1) AS sd,
       round(max_exec_time::numeric,1) AS ms_max, left(regexp_replace(query,'\s+',' ','g'),100) AS q
  FROM extensions.pg_stat_statements
 WHERE query ILIKE '%data_health%'
 ORDER BY total_exec_time DESC LIMIT 10;
```

Se `ms_med` do `data_health_watchdog()` for ~6.000 com `sd` alto, a espera está confirmada no servidor, e o próximo recorte é amostrar o `wait_event` do `job_pid` (de `cron.job_run_details`) durante uma rodada lenta, com um papel que tenha `pg_read_all_stats`. **Não** rode `EXPLAIN ANALYZE` do `data_health_watchdog()`: ele **executa os efeitos** (grava `fin_alertas` e enfileira e-mail).

O conjunto `_data_health_compute` + `data_health_watchdog` + `fin_sync_heartbeat` é acoplado (`docs/agent/sync.md`). Qualquer conserto futuro recria os três juntos, partindo da migration de maior timestamp.
