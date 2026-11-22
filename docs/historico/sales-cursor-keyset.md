# /sales — paginação por cursor (keyset) e custo de render (PR C, 2026-11-22)

Série da listagem `/sales`: #4030 (redesenho) → #4072 → #4080 (filtros) → #4100 (teclado) → **este** (só front).

## O defeito
A query infinita do `order_feed` paginava por **offset** (`.range(offset, …)`). Excluir uma linha de uma
página já lida desloca as seguintes: o antigo 51º vira 50º, a página 2 começa no 52º e **um pedido some
sem sinal** — o `dedupe` só trata repetidos (achado do Codex).

## A correção
- Cursor `(created_at, origin, id)` — e `total` antes na ordem "Maior valor" — da **última linha LIDA**,
  com predicado de `filtroKeysetApos` (`@/lib/postgrest`: DESC/ASC misto, NULLS LAST, valor entre aspas
  que **lança** em metacaractere em vez de "limpar" a chave). Período + keyset num `.or()` só:
  `and(or(<período>),<keyset>)`.
- `total` vai no select como **texto** (`total_cursor:total::text`): é `numeric` com até 14 casas na prod,
  e como número JS o cursor arredondado pularia/repetiria empates.
- `cursor` e `cheia` ficam **na página, gravados na leitura** — o optimistic da exclusão tira linhas e não
  pode recuar o cursor nem encerrar a rolagem (com `rows.length < 50` encerrava).
- A rolagem espera **qualquer** fetch do feed (`isFetching`): o `fetchNextPage` cancela o refetch de
  reconciliação e anexaria a próxima página pelo cursor velho (Codex — pedido cuja exclusão falhou sumiria).

## Provas
- Prod (psql-ro): keyset × offset estático **30/30 páginas idênticas** nas duas ordens; nas 30 fronteiras
  de "recentes" havia empate de `created_at` (data-pura 12:00Z do Omie: 15 linhas num instante).
- PostgREST real (supabase-js + chave anon): os predicados gerados passam o parser (chegam ao banco,
  `42501` de permissão); o controle quebrado na mesma invocação dá `400 PGRST100`.
- EXPLAIN: keyset ~24 ms × offset ~27 ms na página 5.
- Falsificação: offset da main, keyset sem desempate, "Maior valor" sem `total` e `cheia` pelas linhas —
  cada sabotagem fica vermelha com o controle verde na mesma invocação.

## Render
`SalesOrderCard` em `memo` com callbacks que recebem o pedido (estáveis por ref na página), grupos por dia
memoizados (com o dia de hoje na dependência — "Hoje/Ontem" vira à meia-noite), alcance do lote só com o
diálogo aberto. 1.000 linhas, marcar um checkbox: **1.000 → 1** linha re-renderizada. Prefetch do hover só
após 250 ms de permanência (mouse ou foco) e pulado quando fresco ou em voo.

**Lição:** cursor de paginação é estado da LEITURA, não das linhas exibidas — tudo que muta as linhas
(optimistic, filtro local) não pode mover nem encerrar o cursor.
