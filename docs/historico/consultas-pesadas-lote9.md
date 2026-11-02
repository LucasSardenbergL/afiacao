# Consultas pesadas e o índice de `omie_products` (plano v4, lote 9 — B0 e B8)

Plano: `docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`. Migration:
`supabase/migrations/20261102180421_idx_sales_orders_account_omie_pedido.sql`.

## B0 — o dado

- `claude_ro` continua sem ler `extensions.pg_stat_statements` (`permission denied for schema extensions`,
  conferido em 2026-11-02). Ele também não executa `extensions.similarity`, nem `get_data_health()` /
  `_data_health_compute()` (sem EXECUTE), e só vê o próprio texto em `pg_stat_activity` (1 de 31).
  `track_functions = none`, então `pg_stat_user_functions` está vazio.
- A consulta pontual para o founder rodar 1× no SQL Editor (top 20 por `total_exec_time` + top 10 que citam
  `omie_products`, só DML normalizado, com `stats_reset`) foi entregue no chat da sessão. Configuração da
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

## Outras tabelas no topo de `seq_tup_read` (não tratadas aqui)

- `addresses`: 11.023 seq scans lendo a tabela inteira mesmo com o `idx_addresses_user_id` do lote 7 em
  uso; 0 seq scans nas janelas amostradas. Precisa do top 20 para atribuir.
- `radar_empresas`: 0 linhas vivas, 731 MB de heap, 27 k tuplas mortas, sem autovacuum registrado. Fora do
  escopo (é espaço, não consulta).

## Lições

- **Contador de seq scan acumulado não é ritmo.** A média de "1 a cada 3 s" escondia que hoje são ~0,4/min
  em degraus. Amostrar o contador por 1 h separou o cron do polling em minutos, sem `pg_stat_statements`.
- **`pg_stat_xact_user_tables` dentro de `BEGIN … ROLLBACK`** mede quantos scans uma consulta faz de
  verdade, sem depender da leitura de call-sites.
- **Índice parcial + `OR` no predicado = índice invisível.** Quatro índices nas colunas certas e o
  planejador não usava nenhum. Antes de criar mais um parcial, confira se a consulta consegue provar o predicado.
