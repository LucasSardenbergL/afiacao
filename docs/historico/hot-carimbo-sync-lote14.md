# HOT update de volta nas tabelas que o sync reescreve (plano v4, lote 14 — B2/B9)

> 2026-11-01. Migration `20261101222916_hot_carimbo_sync_sem_indice.sql` · prova `db/test-hot-carimbo-sync.sh`.

## O problema

Três tabelas são reescritas linha a linha em todo ciclo de sync, e o carimbo de cada linha **é contrato**:
`_data_health_compute` cobra `inventory_position.synced_at` (3 h), `product_costs.updated_at` (30 h) e
`max(omie_products.updated_at)` (30 h); o CMC é rejeitado após 48 h sem confirmação; o carimbo escolhe a
posição mais recente entre fontes. Por isso "pular linha igual" não serve: perde a confirmação por linha.

Medido na prod (psql-ro, 2026-11-02 01:15Z, contadores desde o restart de 2026-10-31):

| tabela | updates | HOT | linhas | índice do carimbo |
|---|---:|---:|---:|---|
| inventory_position | 136.558 | 0 | 3.346 | `btree(synced_at)`, 1.280 kB |
| product_costs | 190.431 | 2.742 | 3.805 | `btree(updated_at)`, 560 kB |
| omie_products | 150.690 | 0 | 8.075 | `btree(updated_at)`, 264 kB |

## A causa

HOT (versão nova na mesma página, **nenhuma** escrita de índice) só acontece quando nenhuma coluna indexada
muda. As três têm índice **na própria coluna de carimbo** (`20260615095710_idx_data_health_freshness_cols.sql`,
criados só para baratear o `max()` do data_health). O carimbo muda em todo update → nenhum pode ser HOT →
cada update insere uma entrada em todos os índices (3 a 5 por tabela).

Sem os índices, o `max()` vira seq scan: 119/143/827 buffers, todos em cache, 1,0/1,1/4,2 ms (EXPLAIN
ANALYZE na prod, contra 3 buffers/0,06 ms com índice) — ~6 ms a mais por chamada do data_health. Nenhum
outro leitor depende deles: as outras leituras do carimbo são dirigidas por SKU/chave única (`ORDER BY
synced_at DESC LIMIT 1` por SKU, `DISTINCT ON (codigo) ORDER BY codigo, synced_at`, o CAS do zeramento, a
inativação do `omie-sync-metadados` por lote de códigos) — varredura de `src/`, edges e migrations vigentes,
confirmada pelo Codex.

## O achado que mudou o desenho: tirar o índice NÃO basta

Experimento PG17 com `omie_products` no formato da prod, ciclo = upsert de todas as linhas em chunks de 500
na ordem de chave, VACUUM entre ciclos (HOT do 6º ciclo):

| variante | HOT |
|---|---:|
| com índice, fillfactor 100 | 0% |
| sem índice, fillfactor 100 | ~4% |
| sem índice, fillfactor 90 | 58% (98,5% no 10º) |
| **sem índice, fillfactor 80** | **99,4%** |
| sem índice, fillfactor 50 | 100% desde o 2º, mas 1,6× as páginas |

O sync atualiza **todas as linhas de uma página na mesma transação**. Com fillfactor 100 a página está cheia de
versões vivas, a nova não cabe → não-HOT → o FSM a manda para uma página que o vacuum esvaziou, que é
empacotada cheia de novo. As linhas fazem **ping-pong entre duas metades da tabela** — explica por que o heap
da prod tem 2–2,5× o tamanho empacotado. Com fillfactor 80 as relocações deixam folga e a tabela chega
sozinha ao equilíbrio (cada página com espaço para a 2ª versão das suas linhas) em ~5 ciclos.

## O que a migration faz

`LOCK TABLE … IN ACCESS EXCLUSIVE MODE NOWAIT` nas 3, em ordem fixa (tabela ocupada → aborta na hora, sem
segurar as outras; é só re-rodar) · `DROP INDEX IF EXISTS` ×3 · `SET (fillfactor = 80)` ×3 · pós-condição por
**dependência de catálogo** (`pg_depend`/`indkey`): nenhum índice de qualquer nome que use a coluna de carimbo
como chave, INCLUDE, expressão ou predicado, e o fillfactor gravado. Sem coluna, dado ou função tocados; o
carimbo segue escrito em todo ciclo. O UNIQUE duplicado de `inventory_position` ficou fora (com HOT ele
deixa de receber entrada nos updates; segue custando só em insert e update não-HOT).

## Prova (`db/test-hot-carimbo-sync.sh`, PG17, transição real ff100+índices → arquivo da migration)

Aquecimento com o estado de hoje (4 ciclos), depois a migration aplicada como 1 query multi-statement (a
transação implícita do SQL Editor) e mais 8 ciclos:

| ciclo pós | inventory_position | product_costs | omie_products | WAL do ciclo |
|---|---:|---:|---:|---:|
| controle (antes) | 0% | 0% | 0% | 12,6 MB |
| 1 | 13% | 89% | 3% | 10,3 MB |
| 4 | 91% | 98% | 90% | 3,5 MB |
| 6 | 100% | 99,9% | 99,9% | 2,4 MB |
| 8 | 100% | 100% | 99,9% | 2,4 MB (−81%) |

Tamanho total das 3 estável (15,4 → 16,3 MB). Também prova: denominador exato em todo ciclo, valores de
negócio intactos (md5), carimbo do último ciclo em toda linha, chunk não confirmado mantém o carimbo antigo,
idempotência, `NOWAIT` aborta com 55P03 sem tocar a 1ª tabela. Falsificações: 3 de guarda (sem um DROP,
fillfactor 90, índice parcial novo com `WHERE updated_at`) abortam com a marca do ramo; 2 causais (pós-condição
removida) derrubam a medição — sem o DROP, HOT 0%; sem fillfactor, HOT 8%.

Cenário favorável declarado (Codex): sem snapshot longo segurando versões mortas. Transação longa ou
autovacuum atrasado na prod derrubam o HOT do ciclo — por isso o número que vale é o medido na prod.

## Item 2 (pular escrita de linha idêntica): NÃO fazer — o número

Em MVCC, qualquer UPDATE — mesmo só do carimbo — grava uma versão inteira da tupla. Com HOT, "atualizar só o
carimbo quando o resto é igual" custa o mesmo update HOT: a economia de escrita que sobra é zero no heap e
zero em índice. A única economia real seria **não** escrever a linha, o que quebra a confirmação por linha;
mover a confirmação para uma tabela lateral estreita ainda escreve 1 tupla/linha/ciclo e mexe nos leitores do
conjunto acoplado e da regra do CMC de 48 h (money-path). Ressalva do Codex: com TOAST, reenviar JSON igual
regrava o valor externo — **medido: 0 bytes de TOAST nas 3 tabelas** (maior linha de `omie_products`: 725 B,
p99 677 B). Para linhas inline e este volume, não há ganho adicional que justifique mexer nos writers.

## Antes/depois na prod

Antes: ver a tabela do topo (taxa de ~3,6 k / 5,0 k / 4,0 k updates/h, 0% HOT). Depois do apply: medir com
`pg_stat_user_tables` (Δ`n_tup_hot_upd`/Δ`n_tup_upd`) após ≥ 6 ciclos do `sync-inventory-vendas-30m` (~3 h) —
o desfecho entra aqui.
