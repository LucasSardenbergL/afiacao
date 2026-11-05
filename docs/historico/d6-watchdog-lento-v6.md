# D6 — `data-health-watchdog` 4× mais lento: não é o SQL do compute (plano v6, diagnóstico)

**Data:** 2026-11-05 · **Plano:** `docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md` §2 D6 · **Natureza:** diagnóstico read-only, sem PR de código.

## O que foi medido

| Medida | Valor | Fonte |
|---|---|---|
| Duração média/dia do job 101 `data-health-watchdog` | 1,39 s (30/10) → 3,22 → 4,62 → 4,95 → 5,67 → **6,43 s** (05/11), 0 falhas | `cron.job_run_details` |
| Duração do job 82 `fin-sync-watchdog` no mesmo período | 0,87 → 0,56 s (**não** cresceu) | idem |
| Corpo do `_data_health_compute` rodado inline (SELECT puro, read-only) | **229 ms**, 77 k buffers em cache, 0 lidos | `EXPLAIN (ANALYZE, BUFFERS)` via `psql-ro` |
| `_data_health_compute()` chamado como função | **229 ms**, 82 k buffers em cache | `EXPLAIN ANALYZE` via conector Lovable (só SELECT) |
| `SELECT public.data_health_watchdog()` no cron | média de **4,4 s**, máx. 12,7 s, **126 k em cache + 1.123 lidos do disco** por chamada | `pg_stat_statements` via conector Lovable |
| Distribuição | **bimodal**: cada execução leva ~1,5 s ou 5–10 s, inclusive às 02–03 h (sem usuário). Antes de 01/11 a madrugada ficava em 1,2–2 s | `cron.job_run_details` por hora |
| Outros jobs SQL sem relação | `purge-cron-job-run-details` 1,2 → 5,4 s; `detectar-outliers-diario` 0,5 → 2,2 s; `fin-refresh-analise-dimensoes` 1,5 → 2,9 s | idem |

## Hipóteses descartadas, com o teste que descartou

- **Crescimento do `fin_sync_log`** (o plano citava 23.919 tuplas por varredura): tem **24.707 linhas reais**, mas cresce só ~170/dia (0,7%/dia). O `n_live_tup = 849` é artefato do restart de 31/10 10:33, a mesma armadilha do D9: conte com `count(*)`, nunca com `n_live_tup` depois de um restart.
- **Concorrência com o `clientes-import-continuacao-1min`**: apareceu em 88% das execuções lentas contra 35% das rápidas, mas era **viés de seleção**, porque uma janela longa pega mais jobs curtos (esse dura 0,02 s). O cruzamento com as rodadas reais (`clientes_import_rodada`, 15–35 min cada) achou **1** execução coincidente.
- **Vizinho das :00/:30 que ficou pesado**: nenhum job desses minutos cresceu de forma a disputar a cada 30 min; os pesados (`tint-watchdog-fase5`, `radar-score`) são diários e até **caíram**.
- **Listas anexadas ao e-mail** (`_tint_cobertura_bases_lista_email`, `_vendas_familia_ausente_lista_email`): só rodam com a fonte não-ok, e as duas estão `ok`.
- **Escritas do loop / trigger de auditoria**: 0 checks não-ok, então 0 episódios; os 25 UPDATEs batem numa `fin_alertas` de 296 linhas, e o `trg_audit` só dispara em linha alterada.
- **RLS escondendo linhas da minha medição**: `claude_ro` tem `rolbypassrls`; o JIT está desligado.
- **Teste síncrono** (corpo rodado 1 s depois do cron das 12:30 UTC): os dois rodaram rápidos (watchdog 0,68 s, corpo 250 ms). **Não capturou o modo lento**, então é inconclusivo.

## Leitura e hipótese aberta

O custo **não** está no SQL do compute, nem nas escritas do watchdog. Está no **ambiente no instante da execução**: o mesmo trabalho leva 0,2 s com cache quente e 4–10 s no cron, que lê ~1.123 blocos do disco por chamada. A lentidão alcança jobs sem relação, desde ~01/11. Hipótese: pressão de cache/IO na instância. O banco tem 6,9 GB, com `tint_formula_itens` 1,4 GB, `tint_formulas` 1,1 GB, staging do tint ~0,7 GB e `radar_empresas` 1,4 GB, contra `shared_buffers` de 256 MB.

**Não provado.** A latência de leitura não pode ser medida (`track_io_timing = off`), e a importação de fórmulas também foi pesada em 28/10 (627 k inserções), quando o watchdog ainda rodava em ~1,4–3,8 s.

## Impacto e próximo passo

- **Impacto hoje: nenhum para o usuário.** 0 falhas, longe de qualquer timeout; é o vigia rodando de fundo a cada 30 min.
- **Não vale PR de código no watchdog**: otimizar o compute ataca 0,2 s de 4–6 s.
- Para fechar a hipótese é preciso dado de instância, que só o founder tem: os gráficos de CPU, IO e "disk IO budget" do painel Supabase entre 30/10 e 05/11, ou ligar `track_io_timing` (mudança de configuração, também decisão do founder).
- Se o watchdog passar de ~15 s/execução ou outros jobs começarem a falhar, reabrir como incidente de instância, não de função.
