# A IA não precifica: um decisor só para o preço de nascimento do item (2026-09-30)

> Origem: achado da consulta Codex de desenho de 2026-09-27 (entrega `fix/current-date-sp-familia-c`):
> a edge `analyze-unified-order` lia o "último preço praticado" de `order_items` cru, enquanto o front
> usa a RPC `get_ultimos_precos_cliente`. Pergunta do founder: "a edge deveria chamar a própria RPC?".
> Resposta medida: **não basta** — o defeito não era a FONTE do fato, era haver **dois decisores** de preço.

## TL;DR

- O carrinho aplicava o `unit_price` vindo da IA **VERBATIM** e **sem `precoNascimento`** (nunca
  reprecificava) — `useUnifiedOrder.handleUnifiedAIResult`. O item da lista nasce pelo `precoPartida`
  (praticado ≤180d da RPC → tabela×mult(tier) → tabela). Eram dois decisores, e divergiam em escala.
- **Decisão do founder (2026-09-30): "IA não precifica".** A edge só identifica; a resposta sai por
  lista FECHADA de campos (`montarRespostaAnalise`); o item da IA nasce pela MESMA `nascerItemProduto`
  do ADD da lista; o painel exibe o preço com que o item vai nascer. O merge `mergeCustomerPrices`
  ficou sem chamador e foi aposentado. A canária muda de objeto: `praticado-vence-omie-v1` → `ia-nao-precifica-v1`.

## A medição (PROD, `psql-ro`, 2026-09-30)

Denominador: **23.496 pares (cliente, produto)** na união das duas regras (71.865 itens, 1.229 clientes;
0 itens órfãos, 0 pedidos deletados, 0 datas futuras, 52 itens de pedido `cancelado`, 27 itens com
cliente do item ≠ cliente do pedido).

**1. A pergunta original — regra da edge (`order_items` cru, `created_at DESC`, `LIMIT 200`, 1º válido) × RPC:**

| veredito | pares | clientes |
|---|---|---|
| iguais (mesma linha / linha diferente, mesmo preço) | 19.170 (81,6%) | — |
| só a RPC tem preço — **teto de 200 itens** escondeu o produto | **4.315 (18,4%)** | 77 (dos 79 com >200 itens; máx 2.914) |
| preço diferente — linha da edge é de pedido **cancelado** | 6 (Δ mediana 62,9%) | 4 |
| só a edge tem preço — todas as linhas do par são de pedido cancelado | 5 | 4 |
| **empate** de `created_at` com preços diferentes no topo (escolha NÃO-determinística na edge) | 162 | 110 |

Ordenação por `oi.created_at` × data SP do pedido: só 65/71.865 itens têm dia diferente — o eixo de
ordem não gerou divergência; o empate (sem desempate no PostgREST) gerou.

**2. O eixo que a pergunta não cobria — o que o carrinho fazia com o preço da IA:**

- O botão "Adicionar ao Pedido" só existe com cliente selecionado; o front manda `searchCustomer: !hasCustomerSelected`.
- **Fluxo A** (cliente já selecionado — o comum): a edge **não buscava preço nenhum** (`validCustomer` só
  existia no ramo `searchCustomer`); o `unit_price` era o do LLM — que só via a TABELA no prompt
  (`Preço:valor_unitario`) — ou, nos itens resgatados, `match.valor_unitario`. Painel: "R$ X [Preço cliente]".
  Exposição: dos 3.185 pares com praticado ≤180d (onde o manual aplica o praticado), **2.571** têm
  praticado ≠ tabela (Δ mediana 28,4%; 1.920 com praticado ABAIXO da tabela). É TETO, não contagem: só
  vale quando o LLM preenchia o `unit_price` (não persistido — não medível no banco).
- **Fluxo B** (a IA identifica o cliente): `order_items` cru + Omie de qualquer idade, para o cliente que a
  IA identificou (o vendedor podia selecionar outro antes de adicionar). Dos 20.306 pares com praticado
  >180d (onde o manual aplica a tabela), **16.840** têm praticado ≠ tabela (Δ mediana 24,7%; 13.918 abaixo).
- Tier: `tier_preco_config` C=1,05, mas `cliente_tier_preco` com **0 linhas** — inerte hoje.
- Frequência de uso dos fluxos A/B: **AUSENTE** (sem evento PostHog nem registro de uso na edge) — não é zero.

Reprodução: a comparação par a par usa `DISTINCT ON (customer, product)` sobre `order_items ⋈ sales_orders`
com os filtros da RPC (`pg_get_functiondef` de PROD) contra um `row_number() OVER (PARTITION BY customer
ORDER BY created_at DESC, id DESC) <= 200` (o `id DESC` é proxy — a edge real não desempatava; por isso o
bucket de empate é contado à parte). Roda em ~5 s no `psql-ro` (sessão READ ONLY: CTEs, não `TEMP TABLE`).

## O desenho (Caminho B — Codex sem cota)

- **Edge** (`v1.3-ia-nao-precifica`): sai o enriquecimento (leitura de `order_items`, `ListarPedidos`,
  merge), sai `unit_price` do schema do tool e dos 6 resgates, sai `Preço:` do prompt; a resposta passa por
  `montarRespostaAnalise` (saida-ia.ts) — **lista fechada** (`CAMPOS_SAIDA_*`), não "apaga unit_price": a
  garantia é sobre o que SAI, e lista de bloqueio só barra o nome que alguém lembrou (`preco` alucinado vazaria).
- **Front**: `nascerItemProduto` (src/hooks/unifiedOrder/nascimento-item.ts) usada pelo `useCart.addProductToCart`
  E pelo `handleUnifiedAIResult` — paridade LITERAL; `AIProduct`/`AISuggestion` sem `unit_price` (o compilador
  recusa reler preço da IA); painel `PrecoNascimentoIA` (= `getProductPrice`, nada durante `precoLoading` nem
  fora do catálogo); ADD da IA bloqueado por `precoPartidaLoading`, o mesmo gate do ADD da lista.
- **Canária** `ia-nao-precifica-v1`: `canariaSemPreco()` roda a MESMA fronteira sobre fixture COM preço e conta
  pelo NOME LITERAL da chave (comparar com a própria lista seria tautológico) e exige os 2 itens na saída
  (zero preços por zero itens é o sempre-verde). Controles no Deno: a forma velha deixa a canária vermelha (3
  preços); a fronteira que esvazia também.
- **Contrato edge×front** (vitest `edge-money-path-invariants`): `CAMPOS_SAIDA_*` têm de bater campo a campo
  com `AIProduct`/`AIService`/`AISuggestion` — nos dois sentidos.

## Fora de escopo (medido/visto, não corrigido aqui)

- O histórico de compras do PROMPT (`order_items` cru, `LIMIT 50`) conta itens de pedido cancelado como
  "pedido Nx" — afeta QUAIS produtos a IA sugere, não preço.
- `handleUnifiedAIResult` decide "item já no carrinho" pelo `cart` da closure (dois produtos iguais na mesma
  resposta viram 2 linhas) e não exclui item com fórmula de tint; base tintométrica identificada pela IA entra
  como item comum (a lista abre o diálogo de cor). Pré-existentes; o preço deles agora é o do `precoPartida`.
- O selo "Preço cliente" da LISTA (`ProductItemForm`) aparece para praticado >180d que o `precoPartida` não aplica.
- Sensor de uso do fluxo IA: não existe — "quantos pedidos nascem pela IA" segue sem resposta.

## Deploy (3 camadas; merge ≠ produção)

1. **Publish** do front (card da canária exige `ia-nao-precifica-v1`; painel/nascimento novos).
2. **Deploy da edge** `analyze-unified-order` pelo ledger (`bun run pendencias:deploy`).
3. Verificação: card "Canária de preço" verde (só discrimina com OS DOIS deploys — com só um, vermelho
   com motivo próprio: "a edge no ar ainda PRECIFICA"); sonda `v1.3-ia-nao-precifica` via `bun run sonda:sql`.

Codex: desenho=? · código=? — `sem-codex`: o wrapper recusou com a cota em 86% (teto 85%; janela reabre
03/10 19:11) e o founder autorizou o merge sem Codex em 2026-10-01 (**Caminho B**: falsificação Deno 4/4 e
vitest 10/10 sob `LC_ALL=C` e `pt_BR.UTF-8`, controle verde na mesma invocação, + auto-revisão).
**REVISÃO INDEPENDENTE PENDENTE** — rodar o Codex RETROATIVO no diff do #2700 quando a cota reabrir.
