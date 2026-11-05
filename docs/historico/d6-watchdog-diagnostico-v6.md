# D6 — `data-health-watchdog` 4× mais lento: o custo não está no SQL do compute (plano v6)

**2026-11-05, só leitura.** Item D6 do plano v6 (`docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md`, §2 D). Duas sessões mediram em paralelo: esta, via `psql-ro`, e a do lote 4 (`nice-napier`), via `psql-ro` mais o conector Lovable, que alcança o `pg_stat_statements`. O registro junta as duas. **Não há mudança de código nem de banco.**

## O que foi medido

| medida | valor | fonte |
|---|---|---|
| job 101 `data-health-watchdog` (`*/30`), média/dia | 1,39 s (30/10) → 1,82 → 3,22 → 4,62 → 4,95 → 5,67 → **6,43 s** (05/11, parcial); máx. 12,70; 0 falhas | `cron.job_run_details` |
| job 82 `fin-sync-watchdog`, mesmo período | 0,87 → 0,56 s: **não cresceu** | idem |
| corpo do `_data_health_compute` inline (SELECT puro, sessão READ ONLY) | **224 ms** + 20 ms de planejamento; 77 k buffers em cache, **0 lidos** | `EXPLAIN (ANALYZE, BUFFERS)`, `psql-ro` |
| o mesmo corpo às 09:30:03 SP, junto da rodada do cron | 237 ms; a rodada do cron levou 0,68 s | idem |
| `_data_health_compute()` chamado como função | 229 ms, 82 k em cache | `EXPLAIN ANALYZE`, conector Lovable |
| `SELECT public.data_health_watchdog()` no cron | média de **4,4 s**, máx. 12,7 s, **126 k em cache + 1.123 lidos do disco por chamada** | `pg_stat_statements`, conector Lovable |
| distribuição | **bimodal**: ~1,5 s ou 5–10 s, inclusive às 02–04 h, sem usuário. Antes de 01/11, a madrugada ficava em 1,2–2 s | `cron.job_run_details` por hora |
| jobs SQL sem relação | `purge-cron-job-run-details` 1,2 → 5,4 s; `detectar-outliers-diario` 0,5 → 2,2 s; `fin-refresh-analise-dimensoes` 1,5 → 2,9 s | idem |

## Hipóteses descartadas, com o teste que descartou cada uma

- **`fin_sync_watchdog_check` como "o outro check"** (premissa do plano): o job 82 está estável e até caiu.
- **Crescimento do `fin_sync_log`** (o plano citava 23.919 tuplas por varredura): são **24.707 linhas reais**, crescendo ~170/dia (0,7%/dia). O `n_live_tup = 849` é artefato do restart de 31/10 10:33, a mesma armadilha do D9. Depois de restart, conte com `count(*)`, nunca com `n_live_tup`.
- **RLS escondendo custo da medição**: o dono das funções é `postgres` (`rolbypassrls = t`), nenhuma tabela do plano tem `FORCE RLS`, e o JIT está desligado.
- **Escritas do loop e trigger de auditoria**: com 0 checks não-ok, não há episódios. Os 25 UPDATEs batem numa `fin_alertas` pequena, e o `trg_audit` só dispara em linha alterada.
- **Listas anexadas ao e-mail** (`_tint_cobertura_bases_lista_email`, `_vendas_familia_ausente_lista_email`): só rodam com a fonte não-ok, e as duas estão `ok`.
- **Cron concorrente nos :00/:30**: em 144 rodadas, os jobs sobrepostos são todos curtos (sobreposição média ≤ 0,76 s), com correlação ≤ 0,32 com a duração. Os jobs pesados (`tint-watchdog-fase5`, `radar-score`) são diários e até caíram.
- **`clientes-import-continuacao-1min`** (aparecia em 88% das rodadas lentas contra 35% das rápidas): é **viés de seleção**, porque uma janela longa pega mais jobs curtos (esse dura 0,02 s). Cruzando com as rodadas reais (`clientes_import_rodada`, de 15–35 min), só **1** execução coincidiu.
- **Lock**: a amostragem de `pg_locks` a cada 200 ms (visível sem privilégio) não viu espera. Mas ela perdeu a janela das 09:30 e, de qualquer forma, aquela rodada foi rápida. Então isso **não** fica provado.

## Achados laterais (não explicam os 4–6 s)

- O `fin_sync_log` tem só **45% das páginas all-visible** (644 de 1.439). Cada `Index Only Scan` em `idx_fin_sync_log_action_status_completed` faz 11.749 heap fetches, 4 vezes no corpo, ~45 ms no total.
- Outros backends tocaram o mesmo conjunto de tabelas do compute às 09:30:36, :45 e :53. É compatível com o `get_data_health` do front (`useDataHealth.ts`, `refetchInterval` de 120 s por aba em primeiro plano). Isso é inferência: sem `pg_read_all_stats` não dá para ver a query.

## Leitura e hipótese aberta

O custo não está no SQL do compute (0,2 s) nem nas escritas do watchdog. Está no **ambiente no instante da execução**: o mesmo trabalho leva 0,2 s com cache quente e 4–10 s no cron, que lê ~1.123 blocos do disco por chamada. A lentidão alcança jobs sem relação desde ~01/11. A hipótese é **pressão de cache/IO na instância**: banco de 6,9 GB (`tint_formula_itens` 1,4 GB, `tint_formulas` 1,1 GB, staging do tint ~0,7 GB, `radar_empresas` 1,4 GB) contra `shared_buffers` de 256 MB.

**Não provado.** Sem `track_io_timing` (está `off`), a latência de leitura não aparece. E a importação de fórmulas de 28/10 (627 k inserções) também foi pesada, numa época em que o watchdog ainda rodava em ~1,4–3,8 s.

## Impacto e próximo passo

- **Impacto hoje: nenhum para o usuário.** São 0 falhas, longe de qualquer timeout; é um vigia de fundo a cada 30 min.
- **Não vale PR de código no watchdog**: otimizar o compute ataca 0,2 s de 4–6 s.
- Para fechar, falta dado de instância, que só o founder tem: os gráficos de CPU, IO e "disk IO budget" do painel Supabase entre 30/10 e 05/11, ou ligar o `track_io_timing` (mudança de configuração, decisão dele).
- **Reabrir como incidente de instância, não de função,** se o watchdog passar de ~15 s por rodada ou se outros jobs começarem a falhar.
- **Não** rode `EXPLAIN ANALYZE` do `data_health_watchdog()`: ele **executa os efeitos** (grava `fin_alertas`, enfileira e-mail). Qualquer conserto futuro recria juntos `_data_health_compute`, `data_health_watchdog` e `fin_sync_heartbeat`, partindo da migration de maior timestamp (`docs/agent/sync.md`).
