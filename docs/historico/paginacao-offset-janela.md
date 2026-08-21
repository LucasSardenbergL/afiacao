# Paginação por offset sob mutação: o risco não segue o volume de escrita

Medição de 2026-08-21 (psql-ro, prod `fzvklzpomgnyikkfkzai`), levantada pela 2ª rodada do
challenge Codex no #1836 e registrada FORA DE ESCOPO daquele PR — que tratou truncagem
silenciosa (dano PERMANENTE) e não inconsistência sob mutação (dano de JANELA).

## A regra (o que a medição comprou)

**O que desloca uma paginação por offset não é o VOLUME de escrita da tabela — é a escrita
que atravessa a FRONTEIRA DO RECORTE.**

- `INSERT` e `DELETE` **sempre** atravessam: mudam a cardinalidade antes do offset corrente.
- `UPDATE` só atravessa se tocar a coluna do `.order()` **ou** uma coluna do `WHERE`.
  Um update de preço/estoque numa leitura `ORDER BY id` deixa a linha exatamente onde estava.

Corolário que inverte a intuição: **ranquear as tabelas por `n_tup_upd` inverte o ranking de
risco.** Medido:

| tabela | ins | del | upd | pagina? | atravessa a fronteira? |
|---|---:|---:|---:|---|---|
| `product_costs` | 1.174 | **0** | **8.032.695** | sim (3.679) | **não** — `order by id`, filtro imutável |
| `fin_contas_receber` | 1.755 | **0** | 7.177.342 | sim (44.092) | **não** |
| `inventory_position` | 778 | **0** | 6.210.727 | sim (3.134) | **não** |
| `omie_products` | **86** | **0** | 5.324.219 | sim (3.143 ativos) | **SIM** — filtro `.eq('ativo',true)` |
| `order_items` | 67.061 | **1.406** | 88.612 | sim (8 clientes, máx 2.849) | **SIM** — DELETE hard |
| `sales_orders` | 29.057 | 536 | 30.848 | sim (30.979) | parcial — DELETE hard |
| `profiles` | 423 | 0 | 2 | sim (5.668) | não (e já usa keyset onde é money-path) |

As três tabelas mais quentes do banco (8,0M / 7,2M / 6,2M updates) são **seguras**.
A mais fria em escrita real — `omie_products`, com 86 inserts e zero deletes — é a **mais
exposta**, porque quem a reescreve (`omie-sync-status-produtos`, cron diário 03:30 UTC)
mexe exatamente no `ativo` que o `WHERE` do leitor usa: um SKU que flipa `true→false`
entre duas páginas desloca todas as seguintes e um SKU ativo é **pulado**. É o dano do
#1836 (catálogo parcial) pela via da janela em vez da truncagem.

## Os dois mecanismos completos (e por que só estes)

**1. `order_items` no `recommend`** — `.eq('customer_user_id',…).order('id').range(…)`.
`sync-reprocess` faz reconcile diff-based com `.delete().in('id', diff.deletar)`
(`supabase/functions/sync-reprocess/index.ts:339`) e roda `15 */2 * * *` — **inclusive
12:15, 14:15 e 16:15 BRT, em pleno horário comercial**, enquanto o vendedor usa o app
(`recommend` é on-demand via `useRecommendationEngine.ts`, sem cron).
A PK é **uuid v4** (100% das 70.225 linhas): um INSERT cai em posição *aleatória* na
ordenação, então ~50% dos inserts caem **antes** do cursor e deslocam. Com id sequencial
nenhum insert deslocaria — a aleatoriedade do v4 é parte do mecanismo.
Dano: altera `purchaseCounts[product_id]`, que atravessa o corte `purchaseCount >= 2` em
`recommend/index.ts` e muda `ctx_score` (peso `w_ctx` 0.20 no score final).

**2. `omie_products` no `recommend`** — `.eq('ativo',true).order('id').range(…)`, 3.143
ativos ⇒ 4 páginas. Janela de escrita: cron 03:30 UTC = **00:30 BRT, madrugada** — não
cruza o horário de uso. Mecanismo presente, sobreposição baixa.

## O que a medição NÃO sustenta

- **`created_at` de `order_items` não é instante de escrita.** 69.618 de 70.225 linhas
  (99,1%) têm `created_at` = `12:00:00` exato — é data de pedido normalizada. Uma primeira
  medição de "0,051% do tempo com escrita ativa" saiu daí e foi **descartada**: era artefato.
  Só 106 horários distintos em 70k linhas.
- **`pg_stat_user_tables` não tem denominador aqui**: `stats_reset` é `NULL` no Supabase
  (não exposto/nunca resetado), então `n_tup_ins` é acumulado de janela **desconhecida** —
  serve para comparar tabelas entre si, não para derivar taxa por segundo.
- **`cron.job_run_details` mede o ENQUEUE**, não a edge: as três runs dão 0,1s porque é o
  `net.http_post` enfileirando. A duração real veio de `acoes_execucoes`
  (`analytics_sync.sync_completo` 30,9s média / 37,3s máx; `reposicao.sincronizar_recalcular`
  48,7s / 72,8s máx). `net._http_response` não serviu: retém ~6h e já perdeu a URL (drenada
  da queue).
- **`n_live_tup` mente**: dava 392 para `profiles`, que tem **5.668** linhas reais.

## Ordenação por coluna não-única: latente, não ativo

O gate `_shared/paginacao-delegada_test.ts` exige a **presença** de `.order(`, não a
**unicidade** da coluna — `.order('status')` passaria. Auditadas as 6 ordenações por coluna
não-única/mutável, nenhuma tem dano ativo hoje:

- `algorithm-a-audit:239` — **já corrigido** (#1589) com ordem composta `unit_price desc, id asc`.
- `omie-sync-status-produtos:175` (`fornecedor_nome`) — **7 linhas**, nunca pagina.
- `gerar-pedidos-diario:350` (`status`,`fornecedor_nome`) — **18 linhas** no pior ciclo, e sem `.range()`.
- `analyze-unified-order:390` (`descricao`) — `.limit(1000)`, amostra deliberada.

Latente: se qualquer uma crescer além de 1.000 o defeito acorda, e é **determinístico**
(não depende de mutação — basta o plano mudar), portanto pior que o da janela.

## Veredito

Corrigir por keyset **as duas leituras money-path do `recommend`** (mecanismo completo,
`.order('id')` já presente ⇒ a coluna-chave não precisa ser inventada) e **documentar** as
demais: não é migrar os 21 call-sites de `fetchAll`, é o recorte que a medição sustenta.
Precedente do repo, que esta medição confirma em vez de contrariar: `fin-valor-cockpit:490`
já decidiu "display ℹ️ baixo: offset `.range` basta — o syncPedidos, money-path, é que exige
keyset".
