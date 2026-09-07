# O preço de referência do up-sell era escolhido por ordem de uuid

> Achado do #1837, re-verificado e reduzido em 2026-09-07. A metade "preço ausente vira zero"
> já tinha sido fechada pelo #2224; esta é a que sobrou.

## O defeito

`useCrossSellEngine` reduz `sales_orders` a um histórico `(cliente, SKU) → {qty, price}` com a
regra **"último item vence"**. "Último" era a ordem de **LEITURA**: `fetchAllPages` pagina com
`.order('id')`, e `id` é uuid. Ordem de uuid não tem relação nenhuma com a data do pedido — então
`purchaseData.price` era o preço de uma ocorrência **arbitrária** entre as compras daquele SKU por
aquele cliente. Podia ser promocional, negociada, antiga, ou de outra conta do grupo.

Isso sempre governou a **elegibilidade** do up-sell (`premiumPrice > referencia * 1,1`). O #1837
fez o preço governar também a **ORDEM**: `razaoPreco = premiumPrice / referencia` virou a chave
**primária** de `compararCandidatosUpSell` (popularidade só desempata). Referência arbitrária ⇒
razão arbitrária ⇒ **top-2 arbitrário** — e o top-2 é o que chega ao vendedor.

⚠️ A armadilha de leitura: `.order('id')` **não é** o defeito e não podia ser trocado. `id` é PK e
dá a ordem **total estável** que a paginação do PostgREST exige (capa de 1.000 silenciosa,
inclusive em `.rpc()`). O defeito é usar a ordem de LEITURA como se fosse ordem CRONOLÓGICA. O
conserto mora na **redução em memória**, não na leitura.

## A medição (psql-ro, 2026-09-07 — réplica do motor em SQL)

Universo: `deleted_at IS NULL` + denylist de `universo-pedidos.ts`. 31.224 pedidos, 70.884 itens,
identidade resolvida como em `identidade-item.ts` (par `(omie_codigo_produto, account)` no
catálogo ativo).

| O que | Número |
|---|---|
| pares `(cliente, SKU)` com preço utilizável | 13.287 |
| preço de referência **difere** entre uuid e `created_at` | **2.349 (17,7%)** |
| \|Δ\| mediana · p90 | **13,7%** · 42,2% |
| pares com \|Δ\| ≥ 10% · ≥ 50% | 1.545 · 177 |
| uuid pegou pedido **estritamente mais antigo** | **3.881 (29,2%)** |
| atraso mediano · p90 · máximo | **238 dias** · 830 · **2.250** |
| clientes com up-sell | 1.060 |
| clientes cujo **top-2 muda** | **166 (15,7%)** |
| clientes cujo top-2 **ou a base que o sustenta** muda | **316 (29,8%)** |
| clientes que ganham/perdem up-sell | 0 |

**Controle do arnês** (sem ele o 15,7% não valeria nada): o mesmo ranking comparado a **si mesmo**
devolve **0 divergências** nos mesmos 1.060 clientes. A réplica também bate com a medição do #1837
(1.060 clientes com up-sell hoje contra 1.057 em 20/08).

Dois números que decidiram o DESENHO, não só o "vale mexer":
- `created_at` nulo: **0 de 31.224** — o ramo fail-closed existe para o futuro, não para hoje;
- empate no `created_at` do topo: **258 pares (1,94%)** — o desempate **dispara**, então precisa
  ser determinístico e nomeado.

## A decisão

Referência = preço do pedido **mais recente por `created_at`**; empate → maior `id`; dentro do
mesmo pedido → item de posição maior.

É o mesmo **tipo** de grandeza que o código já usava — um preço que este cliente de fato pagou —,
então o significado de "salto" não muda; o que muda é o eixo da seleção passar a ser o que o
código sempre afirmou ser.

Descartadas:
- **mediana das últimas N** — inventa o parâmetro `N` sem dado para calibrá-lo, e mistura
  patamares de preço de épocas distintas (há pares com 6 anos entre as pontas);
- **preço de tabela do SKU** — joga fora o preço **negociado** e torna `razaoPreco` idêntica para
  todos os clientes, apagando a personalização que é o motivo de o up-sell ser por cliente.

## O que o challenge Codex (gpt-6-astra, max) mudou

Quatro achados entraram na entrega; dois foram medidos e reclassificados. O mais caro foi
contra os meus TESTES, não contra o código.

1. **O blast radius estava SUBESTIMADO — e a correção quase dobrou o número.** Eu comparei
   apenas o CONJUNTO de produtos ofertados. Mas a razão de preço também decide **qual compra
   sustenta cada candidato** no dedup, e essa compra vira `currentProductId` /
   `currentProductName` — o "Linha superior a X" que o vendedor lê, e que é **persistido**.
   Medido: **316 de 1.060 (29,8%)** contra os 166 (15,7%) que eu tinha reportado. Lição: ao
   medir o efeito de uma chave de ordenação, o observável é **tudo que a ordenação decide**,
   não só o `id` do vencedor.

2. **🚨 Os meus testes NÃO cobriam o efeito central — e só uma sabotagem mostrou isso.** O
   Codex trocou, em memória, `premiumPrice / purchaseData.price` por `premiumPrice` — ou seja,
   **removeu a referência da chave de ordenação**, que é o defeito inteiro deste PR — e os
   **12 testes continuaram verdes**. Causa: a fixture tinha **UMA base comprada**, e com uma
   base só todos os candidatos dividem pela MESMA referência, então `premium / ref` ordena
   **igual a** `premium`. Os casos A-E mudavam de top-2 pela **elegibilidade** (o piso
   `ref × 1,1` se move), nunca pela **ordem**.
   ⇒ Entrou o caso **F**: DUAS bases compradas, só a referência de uma muda entre os mundos, e
   os dois candidatos seguem elegíveis nos DOIS — o conjunto é idêntico e só a ORDEM inverte
   ([X, Y] → [Y, X]). A sabotagem virou a 7ª do laço de falsificação, agora sobre o HOOK e não
   só sobre o módulo puro.
   **A lição é de método:** um teste que muda de desfecho não prova qual MECANISMO o produziu.
   Quando uma correção tem dois efeitos acoplados (aqui: elegibilidade e ordem), a fixture
   precisa de um cenário em que **um deles esteja congelado** — senão o mais fácil de mover
   responde por ambos, e o gate nasce cego no eixo que motivou a entrega.

2. **`Date.parse` trunca em milissegundo; `timestamptz` guarda microssegundo.** Dois pedidos do
   mesmo milissegundo empatariam e a decisão cairia no `id` — exatamente o eixo que este PR
   existe para tirar da jogada. Medido antes de consertar: **26 dos 31.224** pedidos têm fração
   de segundo (resíduo de quando o sync usava `now()`; hoje ele grava **meio-dia UTC da data
   canônica**), e **nenhum par colide hoje** — 0 de 13.287. Consertado assim mesmo, porque são
   4 linhas e fecha a classe: `instanteDoPedido` devolve **microssegundos**
   (`ms * 1000 + dígitos 4-6 da fração`), com o truncamento do `Date.parse` **verificado**
   (`.123999Z` e `.123001Z` ⇒ os mesmos 123 ms) em vez de suposto.

3. **O fallback `pedidoId = ''` mascarava uma regressão futura.** Se o `id` sumisse do
   `select`, `pedidoId` colapsaria para `''` em TODOS os pedidos e a `posicao` passaria a
   comparar itens de **pedidos diferentes** — ordem inventada entre incomparáveis. Entrou o
   degrau `ordemDeLeitura` (índice do pedido na leitura paginada): o pior caso degrada para a
   ordem de LEITURA, que é a regra antiga — ruim, mas coerente.

O que **não** virou mudança, e por quê:
- **`created_at` vem de `dInc → data_previsao → hoje`** (`omie-vendas-sync`). O Codex leu isso
  como risco de "previsão futura dominar compra real". É dívida **pré-existente e já tratada**:
  o próprio código documenta que `created_at` vinha de `data_previsao`/`now()` e foi
  consertado justamente por sujar a recência. `data_previsao` segue como 2º fallback quando
  falta `dInc` — caveat declarado, não introduzido aqui.
- **`Number(item.quantity || … || 1)`** aceita `0 → 1` e string inválida → `NaN`. Real, e
  pré-existente ao `qty`, que não é o que este PR toca.
- **Limite honesto da medição:** o controle prova `SQL(A) = SQL(A)`, **não** `SQL = hook`. A
  fidelidade da réplica é argumentada (mesmo universo, mesma identidade, mesmos gates) e
  corroborada por bater com o #1837 (1.060 clientes com up-sell hoje contra 1.057 em 20/08) —
  quem amarra a semântica de verdade é o teste do hook, não a réplica.

## Duas armadilhas medidas no caminho

1. **Comparar uuid como STRING só reproduz `.order('id')` porque o texto é canônico minúsculo.**
   Os hífens caem nas mesmas posições e, em ASCII, `'0'..'9' < 'a'..'f'`, então a ordem
   lexicográfica coincide com a binária do tipo `uuid`. Isso foi **medido**, não deduzido:
   31.248 pedidos, 0 fora do canônico minúsculo, e ordenar por `id` e por `id::text COLLATE "C"`
   devolve a MESMA sequência (0 divergências). Um dia em que ids cheguem em maiúsculo, o
   desempate diverge da regra antiga em silêncio.

2. **`NOT EXISTS` correlacionado sobre CTE estourou o `statement_timeout` de 30s** e o shard por
   cliente **não ajudou** — o custo não era proporcional ao recorte, era do laço aninhado. Trocar
   por anti-join com array pré-agregado (`NOT (id = ANY(ids))`) levou a query inteira a **15s**.
   Antes de fatiar uma medição, olhe se o que estoura é o VOLUME ou a FORMA do plano.

## O que o teste prende

`src/lib/farmer/__tests__/preco-referencia.test.ts` (núcleo puro) e
`src/hooks/__tests__/cross-sell-preco-referencia.test.tsx` (desfecho no motor):

- **A** · uuid maior ≠ mais recente ⇒ a referência é a recente e o top-2 muda (o defeito);
- **B** · **controle positivo**: quando uuid e `created_at` concordam, o desfecho é o de sempre —
  sem ele, A passaria só por eu ter INVERTIDO a regra;
- **C** · `created_at` empatado desempata por `id`;
- **D** · data ilegível não se declara recente (fail-closed) **e** não apaga o preço conhecido —
  não repetir o #2224, onde ausência de dado apagava oferta legítima.
