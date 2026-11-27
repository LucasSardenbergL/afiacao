# Revisão /sales — leva 3, PR A1: lista, exclusão, contato, total ausente e erros (2026-11-27)

Achados da revisão Codex r3 + Fable (2026-11-25), leva 3. Esta entrega é a parte **só de front da LISTA /sales**
(sem migration, sem edge). O resto da leva vai em PRs próprios (ver "Fica para depois").

## Re-verificação na main (`b6773166d`)
Todos os achados desta entrega ainda existiam. Conferido em prod (psql-ro, 2026-11-27):
- `order_feed_do_vendedor`, `order_feed_total`, `staff_get_sales_order_payload`: `provolatile='s'` (não podem
  gravar). `contato_cliente_operacional`: `'v'` (grava o ledger de acesso a PII).
- `order_feed`: 32.569 linhas, 0 com `total`/`subtotal` nulo, 0 com `created_at` no futuro. #33 e #31 (fim
  do período) são preventivos.
- Origem Omie (`hash_payload LIKE 'omie\_%'`) × status: 13 em `separacao` ganham "Editar" e 11.269
  `cancelado` ganham "Excluir" que a edge recusa (#5 — fica para o PR com migration).

## O que mudou
- **#13** `lens-write-guard.ts`: as 3 RPCs STABLE acima entram na allowlist. Na lente, "Meus pedidos", o valor
  do recorte e o payload do cupom eram barrados ("Não foi possível carregar os pedidos").
- **#22** `useSalesOrderDetail.ts`: o contato (endereço, telefone, documento) é lido UMA vez (antes, 2 chamadas
  da mesma RPC) e a falha dele não derruba o painel: vira `contatoIndisponivel`. O cupom avisa a equipe e
  invalida o cache do detalhe (o próximo clique lê de novo). Na lente a RPC operacional segue bloqueada, de
  propósito.
- **#14** "Meus" com o vendedor efetivo ainda nulo tem chave própria (`'meus-aguardando'`); a página mostra o
  skeleton. Antes a chave era a de "Todos" e o cache geral aparecia com o rótulo "Meus".
- **#20** Exceção fora do `{ error }` (o guard da lente lança) reconcilia o cache otimista; na lente, "Excluir"
  fica desligado no card e na barra do lote.
- **#23** O painel mostra a divergência entre o desconto apurado nos itens e o total gravado
  (`divergencia` em `resolverDescontoCupom`). Antes, só o toast do cupom falava dela.
- **#31 (parte front)** `useDiaDeHoje`: o dia local vira sozinho à meia-noite, então o corte "Hoje/7d/30d" e os
  rótulos "Hoje/Ontem" acompanham sem precisar de outro render.
- **#33** `subtotal`/`total` saem de `COLUNAS_FEED_EXIGIDAS`: uma linha sem valor derrubava a página inteira, e
  `Number(null)` virava R$ 0,00 no card e no cabeçalho do painel. Agora o valor sai "—".
- **#34** O rodapé usa o `pedidos` de `order_feed_total`, que já conta o recorte. A página não usa mais
  `count: 'exact'` (era um 2º scan). De brinde, com busca o rodapé também mostra o total.
- **#36 (parte lista)** A exclusão em lote fatia os ids em lotes de 100, tanto na marca quanto no rollback. Lote
  que falha na marca não vai ao Omie e conta como falha. `buscarDescontosItens` já usava lotes.
- **#40 (parte lista/painel)** `mensagemDoErroDaLista` dá a mensagem conforme a causa (sem rede, lente, permissão,
  servidor, forma). `PedidoNaoEncontrado` é tipado, sem retry; o painel diz "não encontrei" em vez de "falhou +
  tentar de novo".

## Prova
- Testes novos por achado (`useSalesOrders`, `useSalesOrderDetail` — arquivo novo, `SalesOrderCard`, `feed`,
  `SalesOrderDetailSheet`, `lens-write-guard`).
- Falsificação: uma sabotagem por achado, uma camada por vez, com controle verde na MESMA invocação, em
  `LC_ALL=C` e `pt_BR.UTF-8`. O 1º controle saiu VERMELHO por bug do próprio script (dois caminhos num
  argumento só), e foi isso que impediu um "tudo vermelho" falso.
- **Codex: não consultado** (exit 79, cota em 98% até 02/12). Caminho B: revisão adversarial independente do
  diff por subagente.

## Fica para depois (leva 3)
- **PR A2 (front)**: #28 catálogo × formas de pagamento na edição · #40 na tela de edição · L2-b envio parcial ·
  L2-c parcelas por conta+código no `/sales/print` · L2-d erros lidos no `/sales/print` (baixar a baseline
  erro-colapsado = 4) · #36 nas 2 leituras `.in()` do print.
- **PR B (migration)**: #5 + #32 (coluna `origem_omie` no fim da `order_feed`) · #31 fim exclusivo no
  `order_feed_total` · #19 exclusão concluída pelo servidor · #35 busca calculada uma vez.
- **PR C (edge)**: L2-a quantidade 0/ausente em `omie-vendas-sync`, depois da v1.55 assentar.
- **Decisão do founder**: #21 (valor do recorte conta registros ou PVs distintos?) · L2-e.
