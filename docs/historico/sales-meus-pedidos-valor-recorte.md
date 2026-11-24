# /sales PR D — "Meus pedidos" e valor do recorte (2026-11-23)

Continuação de `sales-cursor-keyset.md` (PR C). Migration `20261123120000_order_feed_vendedor_total.sql`.

## O que entrou

- **Filtro "Meus pedidos"** (`?meus=1`, `useUrlState`): os pedidos em que o usuário EFETIVO (lente "Ver como")
  é o vendedor identificado no Omie (`sales_orders.vendedor_user_id`). A listagem lê de
  `order_feed_do_vendedor(p_vendedor)` (SETOF `order_feed`, SECURITY INVOKER) com os mesmos filtros, a mesma
  ordem e o mesmo cursor da view.
- **Valor dos pedidos do filtro**: `order_feed_total(...)` (count/soma/sem-total) com os mesmos filtros. Ausente é
  "—" (recorte vazio, todos sem valor, carregando, erro); soma com pedido sem valor sai "parcial". Em "Todos"
  a linha avisa que entram cancelados e rascunhos.

## Decisões (Codex, `codex-async.sh`, 2026-11-23)

- **P0 evitado: a view NÃO ganhou a coluna do vendedor.** `order_feed` é `security_invoker` e `sales_orders` é
  fechada por coluna para `authenticated` (vendedor fora de propósito, 20261113120000): pôr a coluna no corpo
  da view faria TODA leitura de `/sales` dar 42501. Seguiu-se o precedente de `pedidos_vendedor`: função
  `SECURITY DEFINER` estreita (`pedidos_ids_do_vendedor`, gate staff pelo usuário real) que devolve só ids.
  Sem GRANT de coluna (a PÓS da migration recusa o grant).
- **"Meu" = `vendedor_user_id`, não `created_by`.** Quem digitou no app pode ser outro staff ou o cliente;
  "zero divergências onde os dois existem" não valida o grupo em que falta um deles. Ficam de fora: afiação,
  vendedor Omie sem usuário no app (4.685 pedidos, quase todos antigos) e os 27 do wizard ainda não lidos.
  A tela diz isso.
- **RPC SQL, não agregados do PostgREST** (desligados; ligar é config global). Um ramo por fonte em plpgsql
  (a função do vendedor recusa NULL e nunca é avaliada fora de "Meus").
- **Paridade por construção + prova nas duas pontas.** O front monta UM `RecorteFeed` de onde saem os filtros da
  lista (`filtrosDoRecorte` + `orDoCorte`) e os params da RPC (`paramsTotalDoRecorte`). PG17
  (`db/test-order-feed-vendedor-total.sh`): 384 recortes, RPC = linhas que os filtros traduzidos do PostgREST
  trazem; vitest: o fake soma pelos PARAMS e refaz a lista pelos FILTROS gravados. Ambos falsificados.

## Medido na prod (psql-ro, 2026-11-23, cache quente)

Soma sem filtro 23 ms · com busca ~1,4 s · "Meus" do maior vendedor 0,1 s (com busca 1,4 s). Teto do
`authenticator`: `statement_timeout=8s`.

## Fora do escopo (pendência conhecida)

`total` nulo ainda quebraria a LINHA da lista (`COLUNAS_FEED_EXIGIDAS`) e a coluna `busca` lê nulo como `0,00`.
Hoje é impossível (`NOT NULL` em `sales_orders.total` e `orders.total`); a RPC já trata o ausente.
