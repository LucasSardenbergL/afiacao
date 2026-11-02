# Consultas pesadas e o índice de `omie_products` (plano v4, lote 9 — B0 e B8)

Plano: `docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`. Migration:
`supabase/migrations/20261102180421_idx_sales_orders_account_omie_pedido.sql`.

## B0 — o dado

- `claude_ro` continua sem ler `extensions.pg_stat_statements` (`permission denied for schema extensions`,
  conferido em 2026-11-02). Ele também não executa `extensions.similarity`, nem `get_data_health()` /
  `_data_health_compute()` (sem EXECUTE), e só vê o próprio texto em `pg_stat_activity` (1 de 31).
  `track_functions = none`, então `pg_stat_user_functions` está vazio.
- A consulta pontual para o founder rodar 1× no SQL Editor (top 20 por `total_exec_time` + top 10 que citam
  `omie_products`, só DML normalizado, com `stats_reset`) foi rodada pelo founder em 2026-11-02 ~23:50 UTC
  (`stats_reset` = 2026-10-31 10:33 UTC, janela de ~61 h); a leitura está em "Top 20" abaixo. Configuração da
  extensão: `track = top` (consulta dentro de função aparece como a CHAMADA da função), `save = on`,
  `max = 5000`.
- Sem o top 20, a atribuição foi feita por **medição direta**, que dá o número exato e não depende de
  contagem de call-site:
  - `pg_stat_xact_user_tables` dentro de uma transação → seq/idx scans exatos de cada consulta candidata;
  - amostragem de `pg_stat_user_tables` a cada 10 s (7,5 min) e a cada 30 s (52 min), segunda-feira
    14h–15h BRT, para ver o RITMO (constante = polling de tela; degrau = cron).

## B8 — `omie_products`: não criar índice por `account`

Contadores desde o restart de 2026-10-31 10:33 UTC (~54 h): 8.075 linhas, 6,6 MB, 64.820 seq scans,
522 M tuplas lidas.

| Fato medido | Valor |
|---|---|
| Distribuição de `account` | `colacor` 4.359 · `oben` 3.716 (seletividade ~50%) |
| `account='oben' AND ativo` | Seq Scan, 827 buffers (todos em cache), 3,0 ms |
| O mesmo com `enable_seqscan=off` | Bitmap no UNIQUE `(omie_codigo_produto, account)` pela 2ª coluna, 5,5 ms — **pior** |
| Índice parcial `(account, tipo_produto)` | 0 usos |
| Edges de sync (`account` + `IN` de 50–500 códigos) | Index Scan no UNIQUE, 325 buffers a 300 códigos, 0,65 ms |
| `_data_health_compute` (trechos de `omie_products`) | **3 seq scans + 84 idx** por chamada (`max(updated_at)` sem filtro, contagem por `account='oben'`, família vazia) |
| `expandir_promocao_item` (`similarity()`) | não rodou nas 54 h (`promocao_item` com 0 insert/update) |
| Ritmo HOJE | 21 seq scans em 52 min, em degraus nos ticks :00/:30 (cron `data_health_watchdog`) ≈ 580/dia |

**Decisão: nenhum índice em `omie_products`.** Nenhuma leitura encontrada filtra só por `account`. Com 2
contas, o seq scan é o plano certo e custa 3–7 ms em cache. O total (64,8 k × ~5 ms ≈ 5 min de CPU em 54 h)
não paga o custo de escrita: a tabela é regravada inteira pelo sync (8.070 de 8.075 linhas nas últimas
24 h, 222 k updates em 54 h, só 11% HOT apesar de `fillfactor=80`). Os 64,8 k acumulados vieram de rajadas
anteriores que não se repetiram nas janelas amostradas (o ritmo atual é ~25× menor que a média).

O que **não** vale a pena, e por quê:

- **`(account)` ou `(account, ativo)`**: seletividade de 50%; o planejador não usaria, e forçar é mais lento.
- **Trigram em `descricao`/`codigo`** (buscas `ilike '%t%'` de `MapeamentoStatusCell`,
  `usePedidosProgramados`, `AdminReposicaoVendaPerdida`, `analyze-unified-order`, RPCs
  `buscar_skus_candidatos`/`listar_skus_por_codigo_fornecedor`): sob demanda, com `limit`, sobre 8 k
  linhas em cache. Um GIN em coluna regravada 27×/dia pesa mais do que economiza.
- **Recriar `(updated_at)`** para o `max(updated_at)` do data health: o lote 14
  (`20261101222916_hot_carimbo_sync_sem_indice.sql`) o derrubou de propósito para destravar HOT; o
  seq scan que voltou custa 3 ms.
- **Diff-before-write no sync**: é o B9 do plano (ADIADO). Ganhou número novo: 222 k updates/54 h, 11% HOT.

## O achado que se pagou: `sales_orders` no vigia de "pedido do app sem gêmeo Omie"

A amostragem mostrou **51 seq scans de `sales_orders` em cada tick :00/:30** e 0 no resto do tempo. O
vigia correspondente do `_data_health_compute` faz, para cada linha do app (~25), um `EXISTS` correlacionado
por `t.account = a.account AND t.omie_pedido_id = a.omie_pedido_id AND (t.omie_payload IS NULL OR
t.hash_payload = 'omie_' || …)`. Os 4 índices que começam por `(account, omie_pedido_id)` são **parciais**
(`hash_payload IS NULL`, `hash_payload IS NOT NULL`, `order_date_kpi IS NOT NULL`), e o `OR` impede o
planejador de provar qualquer um dos predicados.

| | Antes (prod, EXPLAIN ANALYZE) |
|---|---|
| SubPlan | Seq Scan × 25 loops |
| Buffers | 60.525 |
| Tempo | 911 ms |
| Seq scans por chamada | 26 |

Quem chama: o cron `data_health_watchdog` (2 chamadas por tick :00/:30) e `get_data_health()` no
`DataHealthBadge` do AppShell (`useDataHealth`, `refetchInterval` 120 s, só aba em foco). Cada abertura do
selo custava ~0,9 s de banco só nesse trecho.

**Correção: índice completo `sales_orders(account, omie_pedido_id)`**, sem tocar a função de 1.496 linhas
(conjunto acoplado `_data_health_compute` + `data_health_watchdog` + `fin_sync_heartbeat`). Completo e
não `WHERE omie_pedido_id IS NOT NULL`: 32.158 de 32.160 linhas têm o id, e o completo não depende de prova
de predicado. `account`/`omie_pedido_id` não mudam após a gravação, e a tabela já está em 0% HOT, então o
custo é 1 entrada por insert.

Prova local (PG17, réplica sintética com os 4 parciais da prod, 32 k linhas), na mesma invocação: ANTES
`Seq Scan on sales_orders t` (controle vermelho) → DEPOIS `Index Scan using
idx_sales_orders_account_omie_pedido`; re-aplicação idempotente; pós-condição falsificada (homônimo com
outra definição) → `rc=3` com `POS: … existe com outra definição`.

Aplicada em 2026-11-02 pelo `db:aplicar` (ensaio ok → recibo #871). Depois (psql-ro, outra conexão):
`Index Scan using idx_sales_orders_account_omie_pedido` × 25, 5.055 buffers, **26 ms**, 1 seq scan por
chamada. Em uso real, de 18:12 a 18:32 UTC (com o tick das 18:30): `idx_scan` 25 → 202, e `sales_orders`
com +28 seq scans no intervalo inteiro (antes, só o tick dava +51).

## Top 20 do `pg_stat_statements` (janela de ~61 h, 2026-10-31 10:33 → 2026-11-02 ~23:50 UTC)

O banco está folgado: as 20 primeiras somam ~7.370 s em ~220.000 s de janela (~3% de um núcleo, em
média). Por isso o critério aqui é **latência de tela** e custo de fundo recorrente, não CPU total.

| # | Quem (call-site) | Calls | Média | Total | Leitura |
|---|---|---|---|---|---|
| 1 | `realtime.list_changes` (Supabase Realtime lendo o WAL) | 153.694 | 13,6 ms | 2.084 s | Infra. Cresce com o VOLUME DE WAL, não com assinante. Alavanca = escrever menos (B9) |
| 2 | `tint_watchdog_fase5_check()`, cron `0 */6 * * *` | 9 | **153 s** | 1.382 s | Varredura "uma fotografia só" de propósito (guard v5, revisado pelo Codex). Teto `statement_timeout` 10 min |
| 3 | `tint_promocao_tick()`, cron `15 seconds` | 14.564 | 67 ms | 970 s | Custo de fundo, ~4 k blocos por tick. Não medido aqui se o tick ocioso sai cedo |
| 4 | backfill único da canonização tint (CTE `v_old`…) | 1 | 543 s | 543 s | Execução única, não recorre |
| 5 | `data_health_watchdog()`, cron :00/:30 | 122 | 3,5 s | 428 s | Inclui 2× o EXISTS corrigido hoje (~0,9 s cada) |
| 6 | `get_data_health()` no `DataHealthBadge` | 249 | **1,13 s** | 282 s | ~0,9 s eram o EXISTS. Esperado agora ~0,2 s |
| 7 | `tint_sync_errors` + embed `tint_sync_runs!inner` (`useTintAlertas`) | 69 | **4,0 s** | 279 s | JÁ corrigido no #3485 (2026-11-01 13:10 UTC, `.in(sync_run_id)`). A forma nova não aparece no top |
| 8 | `tint_watchdog_corante_check()`, cron 5 min | 732 | 198 ms | 145 s | Fundo |
| 9 | `deploy_sonda_resultados_colher()`, cron 12 min | 305 | 450 ms | 137 s | Fundo (~114 k blocos/chamada) |
| 10 | RPC `fin_titulo_baixas_cr_mapa` (tela CR) | 64 | **1,95 s** | 125 s | Tela. Domínio do lote 15 |
| 11 | `fin_sync_watchdog_check()`, cron 30 min | 122 | 995 ms | 121 s | Fundo |
| 12 | `tint_importacoes` (`useTintometricoZone`, `limit 1`) | 368 | 323 ms | 119 s | Ver "RLS por linha" |
| 13 | `deploy_atestacoes_colher()`, cron 15 min | 244 | 484 ms | 118 s | Fundo |
| 14 | INSERT em `health_score_history` (lote) | 98 | 1,0 s | 98 s | Fundo |
| 15 | `private.expurgar_logs_tint`, cron horário | 14 | 6,8 s | 96 s | Domínio do lote 12 |
| 16 | `tint_preparacoes_tick()`, cron 15 s | 14.619 | 6,5 ms | 94 s | Barato por tick |
| 17 | RPC `fin_capital_giro_prazos_empresa` | 47 | **1,87 s** | 88 s | Tela financeira |
| 18 | `radar_score_recalcular()`, diário | 2 | 43,8 s | 88 s | Fundo, 1×/dia |
| 19 | RPC `reconciliar_pedidos_omie` (edge) | 99 | 879 ms | 87 s | Fundo |
| 20 | `profiles` pendentes de aprovação + `count=exact` (`AdminApprovals`, `useSistemaZone`) | 107 | **797 ms** | 85 s | Ver "RLS por linha" |

**Confirma o B8:** tirando o backfill único (#4), TODAS as consultas que citam `omie_products` somam
~47 s em 61 h. A mais cara é o upsert do sync (495 × 46 ms). Nenhuma leitura de `omie_products` pesa.

**`addresses` está fora do top 20 e da lista B.** Os 11.023 seq scans são de uma tabela de 3 MB e custam
pouco. Não vale índice.

### RLS por linha: o maior ganho de latência de tela, mas é uma CLASSE

As policies de SELECT de `profiles` e `tint_importacoes` chamam `has_role(auth.uid(), …)`. Essa função é
`SECURITY DEFINER` em SQL; o planejador não a inlina, então ela roda **uma vez por linha** (a lição já está
em `docs/agent/database.md`). Prova em `profiles` com o claude_ro, que ignora RLS e não executa
`has_role`, então o corpo da função foi reproduzido como EXISTS:

| Mesmo filtro da tela (16.070 linhas) | Buffers | Tempo |
|---|---|---|
| EXISTS correlacionado por linha (como a chamada por linha) | 32.533 | 28,6 ms |
| A mesma regra como InitPlan `(select …)` | 395 | 4,4 ms |

Isso é um piso. Na prod, cada chamada também paga a troca de contexto do `SECURITY DEFINER`. Medido
foram **797 ms e ~67 k blocos por chamada** (página + `count=exact`). Em `tint_importacoes`, com RLS
ignorada, o mesmo `limit 1` custa 0,06 ms e 4 blocos, contra 323 ms e ~40 k blocos na prod. A diferença
é atribuída à RLS por **hipótese**: reproduzir exige sessão `authenticated` (o claude_ro não assume
esse papel).

**Não tratado aqui.** São **308 policies em 185 tabelas** com `has_role(auth.uid()…` fora de
`(select …)`. Corrigir duas a dedo deixa a classe viva, e reescrever policy é mudança de autorização
(RLS se prova sob `SET ROLE authenticated` + GUC, com falsificação). Fica como entrega própria.

### O que NÃO vale a pena (com o dado em mãos)

- **Realtime (#1):** o custo é decodificar o WAL. Tirar tabela da publicação `supabase_realtime` não
  muda isso. A alavanca é gravar menos linhas sem mudança, o que é o B9 (adiado): `omie_products` com
  222 k updates em 54 h.
- **Vigia fase5 (#2):** é caro por desenho (uma fotografia só, para não gerar "fantasma" entre
  statements). Roda 4×/dia, fora do horário de tela, a 25% do próprio teto de 10 min. Mexer nele é
  domínio tint com parecer Codex. Só vale reabrir se a média se aproximar do teto.
- **Telas financeiras (#10, #17), de ~2 s:** são RPCs de agregação dos lotes financeiros, com 64 e 47
  chamadas em 61 h. Ficam registradas para quem tocar esses domínios, sem índice especulativo.
- **Crons de fundo (#8, #9, #11, #13, #18):** juntos dão ~10 min de banco por dia, fora da tela. Não
  pagam o risco de mexer.

## Outras tabelas no topo de `seq_tup_read` (não tratadas aqui)

- `radar_empresas`: 0 linhas vivas, 731 MB de heap, 27 k tuplas mortas, sem autovacuum registrado. Fora do
  escopo (é espaço, não consulta).

## Lições

- **Contador de seq scan acumulado não é ritmo.** A média de "1 a cada 3 s" escondia que hoje são ~0,4/min
  em degraus. Amostrar o contador por 1 h separou o cron do polling em minutos, sem `pg_stat_statements`.
- **`pg_stat_xact_user_tables` dentro de `BEGIN … ROLLBACK`** mede quantos scans uma consulta faz de
  verdade, sem depender da leitura de call-sites.
- **Índice parcial + `OR` no predicado = índice invisível.** Quatro índices nas colunas certas e o
  planejador não usava nenhum. Antes de criar mais um parcial, confira se a consulta consegue provar o predicado.
- **A média do `pg_stat_statements` mistura o antes e o depois de um conserto** (#7 já estava corrigido no
  meio da janela). Antes de atacar uma linha do top, procure o artefato na main (`git log -S`).
- **O claude_ro ignora RLS.** Um EXPLAIN dele mede a consulta SEM a policy. Para custo de tela, compare
  com a média do `pg_stat_statements`: a diferença é a RLS.
