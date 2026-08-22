# O teto que apagava clientes reais — `sim_score` do motor de recomendação

**Entrega:** `fix(recommend)` 2026-08-22 · migration `20260822000358_recommend_cluster_agregado`
+ edges `recommend/index.ts` e `_shared/recommend-leituras.ts`
**Origem:** o eixo que o [#1852](recommend-amostra-sem-denominador.md) deixou NOMEADO ao consertar
a amostra e o denominador.
**Irmãos da mesma classe:** [`roteirizador-corte-cidades.md`](roteirizador-corte-cidades.md) e o
próprio #1852 — 3ª vez no repo que um corte por ranking usa um EIXO que não é o da decisão.

## O defeito, e por que não era "só uma amostra menor"

`carregarCluster` lia `order_items` dos 50 clientes amostrados com `.order("id").limit(1000)`.
Como `order_items.id` é UUID `gen_random_uuid()`, esse LIMIT **não é janela temporal** — é amostra
de LINHAS. Medido em prod:

| cluster | linhas existentes | vistas | clientes com compra REAL | **ZERADOS** | produtos vistos / reais |
|---|---|---|---|---|---|
| critico | 749 | 749 | 50 | 0 | 299 / 299 |
| atencao | 2.413 | 1.000 | 50 | **5** | 329 / 500 |
| estavel | 16.738 | 1.000 | 50 | **2** | 423 / **1.410** |

Os 5 e 2 são o defeito inteiro: o cliente **tinha** compra, o comprador pesado consumiu o
orçamento de 1.000 linhas antes de chegar nele, e o denominador (50) o contava como "não
comprou". Isso é fabricar zero — o que `money-path.md` §2 proíbe. Em `estavel` a edge decidia
vendo **6% das linhas e 30% dos produtos**.

Recompra e pedido com muitos SKUs gastavam cap **sem mover o numerador**, que conta clientes
DISTINTOS. O orçamento era gasto exatamente no que não era usado.

## A lição de método: a agregação no lugar errado ARRASTA o teto

Agregar no TypeScript obriga a **ler as linhas**; ler linhas obriga a um **teto**; o teto
corta por um eixo que não é o da decisão. A correção não é um teto maior — é mover a agregação
para onde os dados estão. Depois disso o teto vira disjuntor de custo, e o volume que trafega
é o agregado (≤1.410 linhas), não o histórico (16.738).

**Corolário que quase me mordeu:** a RPC devolvendo linha-por-produto **reabriria o defeito**.
O agregado tem 957 / 1.312 / 1.109 produtos e o PostgREST capa em 1.000 em silêncio — inclusive
em `.rpc()`. Dois dos três clusters truncariam **hoje**, e `critico` está a 4% do teto. Por isso
o retorno é **uma linha com `jsonb`** (40–55 kB): sem cap, atômica, sem página inconsistente.
O nº de produtos é limitado estruturalmente pelo catálogo ativo (3.140), então esse eixo não
cresce sem limite — o de clientes sim, e é lá que o disjuntor mora.

## As escolhas de recorte foram MEDIDAS, não estimadas

| recorte | critico | atencao | estavel | veredito |
|---|---|---|---|---|
| histórico inteiro | 406 | 837 | 4.172 | **escolhido** |
| últimos 12 meses | **33** | 149 | 1.410 | rejeitado |
| últimos 10 pedidos | 290 | 404 | 628 | rejeitado |

A janela temporal é **anti-correlacionada com o eixo do cluster**: `critico` É o cluster de quem
parou de comprar, então o `health_class` já codifica recência e filtrar por recência de novo
derruba 92% do sinal justamente onde estão 91,6% dos clientes. (44% dos pares de SKU ativo em
`critico` têm mais de 36 meses, contra 15% em `estavel` — a assimetria é o próprio eixo.)

A amostragem foi **eliminada**, não ajustada: a população elegível é 779 / 348 / 100 e o cluster
inteiro custa **51,9 ms** (`EXPLAIN ANALYZE`, pior caso). Não havia cauda longa a amostrar. De
brinde, a auto-inclusão que o #1852 deixou aberta caiu de 2% para 0,13% / 0,29% / 1,00% — diluída,
não consertada.

## O denominador: por que "população" e não "observados"

Os dois **divergem** (779 vs 633 em `critico`; 348 vs 334 em `atencao`) e a escolha muda
comportamento: com população, zero produtos cruzam 0,10 em `critico`; com observados, dois cruzam.

População é o certo por duas razões:
1. **A leitura é EXAUSTIVA.** Cliente sem par é fato OBSERVADO — "li o histórico inteiro dele e X
   não está lá" —, não truncagem. É precisamente a exaustividade que separa este zero legítimo do
   zero fabricado que a entrega mata. ⚠️ E é por isso que tem **precondição**: se o disjuntor
   morder, o denominador-população deixa de ser honesto. Daí `truncado` devolver NULL, não 0.
2. **"Clientes similares"** no texto que o vendedor lê é a população do cluster, não a
   subpopulação que já comprou algo. Dividir pelos observados é viés de seleção — denominador
   filtrado pelo numerador — e infla `sim` sistematicamente.

## O que muda no que o vendedor vê

| cluster | den antes | sim máx antes | >0,10 / >0,15 / >0,20 | den depois | sim máx depois | >0,10 / >0,15 / >0,20 |
|---|---|---|---|---|---|---|
| critico | 50 | 0,180 | 4 / 2 / 0 | 779 | 0,096 | **0 / 0 / 0** |
| atencao | 50 | 0,240 | 4 / 3 / 1 | 348 | 0,210 | 13 / 2 / 1 |
| estavel | 50 | 0,200 | 8 / 1 / 0 | 100 | **0,430** | 129 / 64 / **34** |

Em `critico` os cortes **deixam de disparar** — e isso é o sistema dizendo a verdade, não uma
regressão: com o cluster inteiro **não há** produto que 10% dos 779 clientes comprem. O `sim` de
antes era maior por ser calculado sobre 50 pessoas, não por haver mais sinal. **Não recalibrei os
cortes de propósito**: baixá-los para fazer o ramo acender seria fabricar disparo.

## O sinal da fase anterior (o que autorizou esta fase)

`recommendation_log` em 2026-08-22: 669 `cross_sell` + 28 `repurchase` + **1 `cluster_based`**.
O #1852 mediu **zero, sempre**. O ramo acendeu pela primeira vez depois daquele deploy — é a
evidência positiva com denominador que `docs/historico/fase-sem-sinal.md` exige antes da fase N+1.

## Prova

- **SQL provado EXECUTANDO** em PG17: `db/test-recommend-cluster-agregado.sh` — 25 asserts, 6
  falsificações (dedup, whitelist, NULL-sob-truncagem, REVOKE, SKU ativo, universo de pedidos).
  O assert **A0 é o controle**: reproduz a leitura antiga e exige que ela zere um cliente real —
  sem ele, "nenhum cliente zerado" não provaria conserto nenhum.
- **A falsificação achou um assert sem dente** e isso vale registrar: o teste do REVOKE passava
  **sem** o REVOKE, porque no harness `authenticated` não tinha SELECT nas tabelas e o 42501 vinha
  da tabela, não da função. No Supabase real `authenticated` **tem** SELECT (a RLS é que filtra),
  então o harness testava um mundo que não existe — e o REVOKE, que lá é a única barreira, parecia
  redundante. Lição: **um harness que não espelha os GRANTs do ambiente real transforma defesa em
  redundância aparente.**
- **Antes/depois medido:** `db/recommend-cluster-rpc-antes-depois.sql` (read-only).
- **Edge:** 38 testes em `recommend-leituras_test.ts` (`test:edges` 825/825), com 4 falsificações
  próprias conferindo dente.

## ⚠️ REVISÃO INDEPENDENTE PENDENTE

O ritual `/codex` não pôde rodar: a conta recusa **todos** os modelos com HTTP 400
(`model is not supported when using Codex with a ChatGPT account`) — e o
[#1860](https://github.com/) já mediu que o eixo não é o nome do modelo (10 nomes, mesmo 400), é o
acesso da conta. Seguido o **Caminho B** de `money-path.md` §170: PG17 falsificável + auto-challenge
com medição. Auto-prova **não** substitui revisão independente — rodar o Codex retroativo quando o
acesso voltar, mirando em: (a) denominador população×observados, (b) histórico inteiro carregar par
de 6 anos, (c) a renormalização de pesos sob `truncado`.

## Segue aberto (nomeado para não passar por consertado)

- **auto-inclusão**: diluída para 0,13%/0,29%/1,00%, não consertada — falta leave-one-out;
- o cluster é global por `health_class` e **ignora `farmer_id`**, embora a coluna exista;
- **os cortes 0,10/0,15/0,20 não foram recalibrados**, e agora mordem de forma muito diferente por
  cluster (0,096 em `critico` com n=779; 0,430 em `estavel` com n=100). Recalibrar exige decidir se
  o corte é sobre proporção ou sobre contagem absoluta — e isso é decisão de produto, não de
  implementação;
- o caminho de degradação sob `truncado` **nunca executa hoje** (779 « 5.000): é disjuntor, e sua
  primeira execução real será a primeira vez que alguém o vê funcionar.
