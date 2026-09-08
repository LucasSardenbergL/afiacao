# A RPC do "melhor individual" elege por uuid em 98,7% dos casos — desenho do conserto

> Continuação de `docs/historico/affinity-score-duas-grandezas.md` (#2350), que mediu o defeito e
> deixou a RPC de fora **de propósito**, com 5 critérios de aceite. Este é o desenho que os atende.
> Medições em prod: `psql-ro`, 07/09/2026, geração de 21/08/2026, 1.083 recomendações pendentes.
>
> **Revisão 2** — a revisão 1 foi REPROVADA pelo challenge Codex (`gpt-6-astra`, `max`, 522 s,
> 159k tokens). Seis achados entraram; dois exigiram medição nova, e uma delas quase derrubou a
> peça central. O que mudou está em §7.

## 1. O que a re-medição acrescentou à fotografia do #2350

A fotografia do doc **reproduziu exatamente** (714 cross-sell + 369 up-sell, mesmas faixas, 186/186
up-sell vencendo entre pares com os dois tipos, 52 vencedores cross-sell = exatamente os pares sem
up-sell).

### 1.1 O desempate por uuid alcança também o cross-sell

O #2350 registrou que o `id` uuid decide dentro do up-sell (183/183) e ressalvou: *"não diz que o
score nunca decide NADA — nos 52 pares sem up-sell ele ainda escolhe entre produtos cross-sell"*.

**Medido: falso.**

| eixo | grupos | topo empatado |
|---|---|---|
| empate no topo dentro do `cross_sell` | 238 | **198 (83,2%)** |
| `cross_sell` que VENCE a RPC (pares sem up-sell) | 52 | **52 (100%)** |
| `up_sell` que vence a RPC | 186 | **183** |

`updated_at` não desempata nada (é o instante da transação de geração, igual para o lote inteiro).
Somando: **235 dos 238 pares (98,7%) têm o produto eleito escolhido pelo `id` uuid v4.**

⚠️ **Limite desta afirmação** (challenge Codex): 98,7% é a **incidência do último critério usado**
— não é dano comercial, nem taxa de produto errado. Ela não autoriza dizer que este defeito
"engole" o da precedência entre tipos, nem que uma política entre tipos consertaria "~0%": trocar
a política mudaria a FAMÍLIA da oferta em 186 clientes, que é outro efeito. Não há medição que
ordene a importância dos dois. São defeitos separados (critério 4), e ficam separados.

### 1.2 A precedência entre tipos é um limiar, não um artefato de escala

Os dois motores computam `P(conversão)` do MESMO cliente. `healthScore` e `engagementFactor` são
calculados **uma vez por cliente** e reusados nos dois (`useCrossSellEngine.ts:835`), então
cancelam na comparação:

```
cross: pij = 0,15 × (health/100) × engagement × relevance   relevance = clamp(cA·0,4 + aB·0,6, 0,01, 1,0)
up:    pij = 0,10 × (health/100) × engagement × 0,8

up > cross  ⟺  0,08 > 0,15 × relevance  ⟺  relevance < 0,5333
```

**A evidência do cancelamento é a leitura do código** — as mesmas variáveis, para fatores positivos
e finitos —, não uma inferência sobre os dados.

⚠️ **A revisão 1 alegava um teste empírico que não sustenta o que dizia.** Eu afirmei que a
`relevance` implícita `(max_cross/max_up)/1,875` cair 186/186 dentro de `[0,01 , 1,0]` seria
"coincidência absurda". Não é: como o up-sell vence os 186 pares, `max_cross/max_up < 1` **sempre**,
logo a implícita é `< 0,5333` **por construção** e o limite superior nunca poderia falhar. Só o
limite inferior testava algo, e frouxamente — fatores de cliente diferentes entre os motores também
produziriam valores dentro do intervalo. O teste que **distingue** é reconstruir `relevance` a
partir dos insumos e comparar `round4(previsto)` com o persistido, sabotando **um** motor com um
fator extra; fica registrado como método, não executado aqui (reconstruir com insumos de hoje
testaria o motor de hoje, não a geração de 21/08).

⚠️ E o bicondicional vale no score **antes do arredondamento**. Com `relevance = 0,5332` o cross
bruto é `0,011997` contra `0,012` do up, mas ambos gravam `0,012` — e aí a RPC pode eleger cross
pelo desempate. A fronteira exata é do valor bruto; o persistido tem uma faixa cinza de largura
1e-4.

A assimetria que importa para o produto é outra: **o score do cross-sell é descontado por um termo
de aderência ao PRODUTO; o do up-sell não tem termo de produto nenhum** (o `0,8` é constante para
todo candidato). O número do up-sell não estima o produto — estima o cliente. Comparar os dois é
comparar "P(compra ESTE complementar)" com "P(compra ALGO mais caro)".

### 1.3 Substrato para "moeda comum" não existe hoje

`lie` e `m_ij`: **0 de 17.316 linhas** populadas (colunas mortas, como `best_individual_lie`).
Comparar em R$ exigiria reintroduzir margem no motor — removida do browser de propósito no #1837.

## 2. As decisões (do founder, 07/09/2026)

| # | Decisão | Critério |
|---|---|---|
| D1 | A RPC devolve o **melhor de CADA tipo**, sem compará-los | 1 e 5 |
| D2 | Eleição não decidida por sinal → **não elege** | 4 |
| D3 | A ordem em MEMÓRIA do cross-sell entra na mesma entrega | — |
| D4 | O cartão ganha **duas células rotuladas** | — |

**D1 dissolve a comparação em vez de inventá-la** — a única saída que não viola o critério 5:
declarar `up_sell > cross_sell` reproduziria um viés observado, e nenhuma regra comercial autoriza
a precedência.

## 3. O desenho

### 3.1 `farmer_recommendations.ordem smallint NULL`

Rank **denso**, base 1, escopo `(farmer_id, customer_user_id, recommendation_type, run_id)`.

**Candidatos empatados no sinal recebem o MESMO valor.** É a peça que impede a entrega de trocar o
endereço do bug: com posições distintas para empatados, o vencedor passaria a ser o índice do array
— a varredura do catálogo, que é `.order('id')`, que é uuid **de novo**.

Nulável porque as 1.083 linhas de 21/08 existem e não são recuperáveis (§3.5).

### 3.2 Quem calcula o rank (critério 2)

- **`cross_sell`**: `pij` **não arredondado**, desc. Empate genuíno (mesma `relevance`) compartilha
  rank.
- **`up_sell`**: `compararCandidatosUpSell` (menor razão de preço → maior popularidade), sobre a
  referência cronológica de `preco-referencia.ts`. `upsell-ordem.ts` já tem o comparador **e** o
  predicado de empate (`candidatosEmpatam`, hoje privado) — o rank denso reusa os dois.

**Quanto isso recupera, medido — e eu errei DUAS vezes antes de acertar.** Dentro de um cliente,
`relevance = clamp(0,4·k/N + 0,6·aB, 0,01, 1,0)`, com `k` = compradores do SKU **na carteira**
(N=269, medido) e `aB` reconstruído das regras de associação. Recuperável ⟺ o **máximo é ÚNICO**.

| tentativa | critério usado | resultado | por que estava errado |
|---|---|---|---|
| 1 | `k` GLOBAL distinto | 198/198 | a carteira é 269 de milhares; SKUs que se separam na base colidem no recorte |
| 2 | `k` de carteira distinto | 104/198 | heterogeneidade ≠ máximo único — `k=[6,6,5]` tem valores distintos e nenhum vencedor |
| **3** | **máximo único de `relevance`** | **9/198 (4,5%)** | — |

| | n | % dos 198 |
|---|---|---|
| máximo ÚNICO ⇒ recuperável pelo rank | **9** | 4,5% |
| **sem vencedor único (empate REAL)** | **189** | **95,5%** |

**Controles** (por que acredito nesta versão e não nas duas anteriores): a fórmula
`clamp(buyerCount/totalCustomers, 0, 1)` foi conferida no código (`useCrossSellEngine.ts:872`);
682 de 714 linhas têm `k ≥ 9`, que é o gate `cA ≥ 0,03`, e as outras 32 entram por `aB > 0`;
`k ∈ [1,22]` com N=269 dá `cA·12 ∈ [0,045 , 0,98]`, que reproduz `cluster_volume_estimate = 1` em
714 de 714; e a `relevance` reconstruída (máx 0,0327 com `aB=0`) bate com a mediana 0,0338 obtida
por um caminho **independente**, a razão entre os scores persistidos.

⇒ Sobre os 238 grupos cross-sell **hoje persistidos**: 40 já decididos pelo score + **9**
recuperados = 49 com vencedor; **189 sem**. ⚠️ Isto descreve o conjunto ATUAL — **não** é previsão
da tela pós-entrega, e a revisão 3 apresentava como se fosse (achado R3/4). D3 muda a ordenação
antes do corte, logo muda o próprio conjunto persistido: quem mede a tela é o sensor de §6.1.

**Dois recortes que o challenge exigiu, medidos agora:**

| | resultado |
|---|---|
| tamanho dos grupos sem vencedor único (sobre os **189**, não os 94 da revisão 2) | **2 em 189 de 189** |
| clientes **cross-only** (sem up-sell — os 52 em que o cross-sell é a ÚNICA indicação) | 52 |
| …empatados no score arredondado | **52 de 52** |
| …**recuperados pelo rank** | **0 de 52** |

O segundo recorte é o que importa e é pior do que o agregado sugeria: **os 9 grupos que o rank
recupera estão TODOS em clientes que também têm up-sell**, onde D1 já entrega o up-sell como a
oferta do tipo dele. Nos 52 clientes em que a célula cross-sell é a única coisa que o vendedor tem,
o rank não recupera **nenhuma** eleição.

**O que isso muda na proposta de valor, dito sem maquiagem:** o rank do cross-sell não ELEGE — ele
faz a tela **parar de mentir**. Hoje esses 52 clientes recebem um vencedor sorteado por uuid
apresentado como veredicto; passam a receber **dois nomes rotulados como igualmente indicados**, e
quem escolhe é o vendedor, que tem o contexto que o motor não tem. A causa é o sinal ser grosso:
`k ∈ [9,22]` sobre N=269, com `aB = 0` na maioria, produz colisão EXATA de `relevance`. Não é
arredondamento nem ordenação: é ausência de informação, e nenhuma mudança de `ORDER BY` a cria.

O rank continua necessário pelo **up-sell**, onde o comparador do #1837 usa termos que **dependem do
produto** — razão de preço e popularidade — enquanto o `pij` do cross-sell não usa nenhum. Essa é
uma afirmação sobre o CÓDIGO, verificável em `upsell-ordem.ts:113`; **quanto** o up-sell discrimina
em prod depois de referência, dedup e corte é a mesma pergunta não-derivável do banco de §6.1, e o
sensor a responde. Incluir o cross-sell na mesma coluna é quase de graça e remove a dependência do
arredondamento como proxy de empate.

**Nada disto toca `affinity_score` nem `p_ij`.**

### 3.3 RPC `farmer_melhores_individuais_por_cliente(uuid)` (nome novo — §3.4)

Devolve `jsonb` com até **dois** objetos por cliente (um por tipo):

```
customer_user_id · recommendation_type · situacao · produtos · produto_eleito
                 · candidatos · affinity_score · run_id
```

**Identidade e eleição são campos SEPARADOS** (achado R3/2). A revisão 3 tinha um único
`product_id` preso ao guard "só é não-nulo em `eleito`" e, ao mesmo tempo, prometia exibir o nome
do produto em `unico_registrado`. O nome não tinha de onde vir: o contrato eliminava o
identificador exatamente nos estados em que a tela precisava dele. **Identificar produtos não exige
afirmar prioridade entre eles** — e é essa separação que permite nomear sem eleger:

- **`produtos`** — array de SKUs que a tela vai NOMEAR. Sempre ≥1 elemento.
- **`produto_eleito`** — não-nulo **se e somente se** `situacao = 'eleito'`, e sempre um elemento de
  `produtos`. É o guard estrutural que impede renderizar vencedor por descuido.
- **`candidatos`** — **sempre** o tamanho do grupo registrado. Um número, um significado.

⚠️ A revisão 3 fazia `candidatos` contar um conjunto DIFERENTE por estado. Aquilo consertava a
mentira do R2/3 (`[A:1, B:1, C:2]` tem **2** empatados, não 3) criando outra: um campo cujo
denominador o consumidor precisa inferir do rótulo. Com `produtos` transportando quem é nomeado e
`candidatos` medindo o grupo, o mesmo caso vira `produtos=[A,B]`, `candidatos=3` — e a tela diz
"2 de 3", que é a frase verdadeira.

**Estados, em ordem de PRECEDÊNCIA** — a primeira condição que casar decide. Sem isso um singleton
com ordem conhecida satisfaz duas linhas da tabela ao mesmo tempo (achado R3/2):

| # | `situacao` | condição | `produtos` | significado |
|---|---|---|---|---|
| 1 | `referencia_ambigua` | qualquer linha do grupo com a flag de §5 | todos os registrados | a ordem saiu de uma referência sorteada |
| 2 | `ordem_indisponivel` | ≥2 candidatos e QUALQUER `ordem` nula | todos os registrados | ordenação ausente ou incompleta |
| 3 | `unico_registrado` | exatamente 1 candidato | o único | identificável; nada foi ordenado |
| 4 | `empatado` | ≥2 candidatos · ordens todas conhecidas · ≥2 no rank mínimo | os do topo | igualdade MEDIDA |
| 5 | `eleito` | ≥2 candidatos · ordens todas conhecidas · 1 no rank mínimo | o vencedor | decidido por sinal |

⚠️ **A precedência 1 é o que fecha o R3/1.** Ambiguidade a montante invalida qualquer afirmação de
eleição **e** de empate: um empate calculado sobre uma referência sorteada não é igualdade medida,
é coincidência de um sorteio. Colapsá-la em `ordem_indisponivel` também serviria à tela — mas
apagaria a única distinção acionável entre "ninguém ordenou" (falta rank) e "ordenei sobre um dado
arbitrário" (defeito a montante, em `preco-referencia.ts`). São causas diferentes com consertos
diferentes, e um booleano paralelo ao lado do enum recriaria os dois-vocabulários-numa-coluna que
o repo já pagou caro para desfazer.

⚠️ **`unico_registrado` existe porque `eleito` mentiria** (achado R2/3). Um grupo de um candidato não
foi decidido por sinal de ordenação nenhum: ser a única recomendação registrada permite
identificá-la, e não diz nada sobre a qualidade da escolha que a produziu. Com a precedência, um
singleton **nunca** sai `eleito`, tenha `ordem` ou não.

⚠️ **`ordem_indisponivel` cobre DOIS casos** e o rótulo não afirma mais do que sabe: `[null, null]`
(ninguém ordenou) e `[1, 2, null]` (ordenação incompleta). A tela diz "ordenação indisponível", não
"ninguém mediu" — a segunda frase seria falsa no segundo caso.

O `affinity_score` continua no payload como **dado de diagnóstico do tipo**, nunca como critério
entre tipos: D1 dissolveu a comparação, e §1.2 mostra por quê.

### 3.4 Por que nome NOVO

A RPC atual fica **intocada**: entre a migration e o Publish, o front velho chama a RPC velha e
nada muda. Trocar a assinatura da atual faria o front velho receber duas linhas por cliente, e o
`melhorIndividual.set(customer_user_id, …)` guardaria a última — arbitrário de novo, e invisível.
Também evita o `DROP`+`CREATE` que **reseta o ACL** (`database.md` §4).

### 3.5 Registros existentes (critério 3) — sem backfill

Os 1.083 pendentes de 21/08 nascem com `ordem` nula. Os grupos com **≥2** candidatos saem
`ordem_indisponivel`; os de **um só** candidato saem `unico_registrado` e exibem o nome — e a
distinção não é teórica: 369 linhas up-sell em 186 grupos implicam **pelo menos 3 grupos de uma
linha** (achado R2/3, que derrubou o "todos sairão como ordem desconhecida" da revisão 2).

⚠️ **Correção da revisão 1**, que se contradizia: eu afirmava que isso "vale no dia da migration,
antes de qualquer recálculo". **Não vale** — §3.4 mantém a RPC antiga servindo o front antigo, então
nada muda até o Publish ser **adotado** pelo cliente. O conserto começa na adoção, não na migration.

Backfill descartado: a ordem não é recuperável das colunas existentes, e re-derivar com preços de
**hoje** sobre uma geração de **21/08** fabricaria número.

### 3.6 Leitor e tela (D4)

O leitor muda em sete pontos; seis são armadilhas que o challenge apontou.

1. **A chave do Map passa a incluir o tipo** (`useBundleEngine.ts:844`) — hoje é uma linha por
   cliente, e o segundo objeto sobrescreveria o primeiro.
2. **Todo estado resolve nome no catálogo.** Hoje `pid == null` cai direto em `produto_nao_resolve`
   (`useBundleEngine.ts:1050`). Com identidade separada de eleição (§3.3), o leitor resolve **todos**
   os SKUs de `produtos`; `situacao` decide o que a apresentação SIGNIFICA, não se existe
   apresentação. A regra da revisão 3 ("só `eleito` tenta resolver SKU") era o que tornava os nomes
   prometidos irrecuperáveis.
3. **SKU válido que não resolve ≠ leitura inválida** (achado R3/3). São dois defeitos distintos e a
   tela não pode fundi-los:
   - **nenhum** SKU de `produtos` resolve → célula `indisponivel · produto_nao_resolve`;
   - **alguns** resolvem → mostra os que resolveram **e declara quantos não identificou**. Em
     `empatado`, perder um nome **não** promove o outro a vencedor: a célula segue `empatado`, com
     "1 de 2 não identificado". Esconder o participante que sumiu converteria uma falha de catálogo
     em eleição — exatamente a fabricação que esta entrega existe para matar.
4. **O sensor de resolução** (`useBundleEngine.ts:1163`) conta SKU que não resolve, e só isso —
   estado sem eleição não é falha de catálogo e contá-lo fabricaria deterioração.
5. **O filtro de inclusão do cartão** (`useBundleEngine.ts:1073`) passa a omitir o cliente só quando
   **ambos** os tipos são `nenhum`.
6. **Validação em runtime, com invariantes ENTRE campos** (achado R3/3). Só validar campo a campo
   deixa passar `{situacao:'empatado', candidatos:1, produtos:[]}` — que satisfaz "tipo reconhecido",
   "inteiro ≥1" e "sem produto eleito fora de `eleito`", e não representa empate nenhum. O contrato
   verificado:

   | invariante | vale para |
   |---|---|
   | `customer_user_id` uuid presente · tipo reconhecido · `(cliente,tipo)` sem duplicata | todos |
   | `situacao` ∈ enum de 5 · `candidatos` inteiro ≥1 | todos |
   | `produtos` array de uuids válidos, **sem duplicatas**, `1 ≤ length ≤ candidatos` | todos |
   | `produto_eleito` não-nulo **⟺** `situacao='eleito'`, e ∈ `produtos` | todos |
   | `length(produtos) = 1` ∧ `candidatos ≥ 2` | `eleito` |
   | `length(produtos) = 1` ∧ `candidatos = 1` | `unico_registrado` |
   | `length(produtos) ≥ 2` ∧ `candidatos ≥ 2` | `empatado` · `ordem_indisponivel` |

   **A resposta inválida é rejeitada INTEIRA como `leitura_falhou`, preservando a causa** —
   validar-e-descartar linhas transformaria falha em ausência e entregaria um Map parcial
   apresentado como completo (achado R2/4). Sem a checagem de `customer_user_id` as demais passam e
   a linha some na consulta pela chave, que é a mesma falha por outra porta.
7. **`geracoesExibidas`** (`useBundleEngine.ts:1057`) só recebe `run_id` quando o produto resolve.
   Com os estados novos, cartões exibiriam empates e ordens indisponíveis de gerações diferentes sem
   alimentar o canário — a contagem passa a acompanhar **todo estado exibido**.

**Preservar** (o challenge listou, e nenhum é consequência automática do desenho): o cartão continua
aparecendo quando há bundle, mesmo com os dois individuais em `nenhum`; o aviso do cartão recolhido
(`CustomerBundleCard.tsx:68`), hoje dependente do estado individual único; e a proibição de comparar
`ordem` de `run_id` diferentes dentro de uma mesma eleição.

O cartão ganha **duas células rotuladas** ("Melhor complementar" · "Melhor upgrade"), cada uma com:

| estado | mostra |
|---|---|
| `eleito` | nome do produto |
| `empatado` | "Igualmente indicados: A, B" (`candidatos` no rodapé quando > `length(produtos)`) |
| `unico_registrado` | "Única registrada: A" |
| `ordem_indisponivel` | "Ordenação indisponível — A, B (N registradas)" |
| `referencia_ambigua` | "Sem ordem confiável — A, B" |
| `nenhum` | — |
| `indisponivel` | rótulo + motivo (leitura falhou · SKU fora do catálogo) |

⚠️ **Nomear em todos os estados é o que evita trocar uma mentira por uma omissão.** A revisão 3
mostrava contagem sem nomes quando a ordem era desconhecida, com o argumento de que listar produtos
afirmaria igualdade. Não afirma: quem afirma é o RÓTULO, e o rótulo é o campo `situacao`. Retirar os
nomes deixaria o vendedor sem nada acionável justamente nos 52 clientes cross-only, onde **nenhuma**
eleição é recuperável (§3.2) — a célula viraria um aviso de indisponibilidade permanente.

### 3.7 Ordem em memória do cross-sell (D3)

`crossSellRecs.sort((a,b) => b.affinityScore - a.affinityScore)` ordena pelo score **arredondado**;
o `sort` é estável, então entre empatados vence a ordem de inserção — a varredura do catálogo, que
vem de `.order('id')`. O top-3 do vendedor é uuid pelo mesmo mecanismo. Passa a usar a chave densa.

## 4. Escopo da garantia — o que esta entrega NÃO cobre

⚠️ **A revisão 1 chamou a RPC de "a fronteira que toda via cruza". É falso**, e o challenge
demonstrou executando:

- **O preview do WhatsApp lê `farmer_recommendations` direto** (`usePropostaPreview.ts:104`) e
  reordena pelo score arredondado (`cross-sell.ts:31`). Com três afinidades iguais, inverter a
  entrada muda os produtos selecionados. Não passa pela RPC nem pela `ordem`.
- **Os cortes top-3/top-2 do motor** (`useCrossSellEngine.ts:1045`) já descartam candidatos
  empatados **antes** da persistência. `candidatos` conta recomendações persistidas, não todos os
  candidatos que o motor viu.

A garantia fica restrita ao **cartão de bundles**. Estender à via do WhatsApp e ao corte é trabalho
próprio, com medição própria.

## 5. Ambiguidade a montante do rank — por CLIENTE, não por linha

`compararRecencia` (`preco-referencia.ts:108`) desempata por `pedidoId` (uuid) quando o instante é
indistinguível — datas iguais **ou ambas ausentes**. Isso escolhe o preço de **referência**, que é a
chave primária da ordem do up-sell: um rank pode ser numericamente único (`eleito`) e ainda carregar
uma decisão arbitrária na origem. O challenge executou os helpers reais trocando só os uuids e o
vencedor mudou.

**Incidência, medida** (o challenge R1 a declarou desconhecida):

| | n |
|---|---|
| pares (cliente,SKU) com preço utilizável | 13.290 |
| topo com empate de data entre pedidos DISTINTOS | 157 |
| **desses, com preços distintos ⇒ o uuid muda a referência** | **23 (0,17%)** |
| clientes atingidos | 14 |
| **∩ com os 186 clientes de up-sell vivo** | **2 (1,1%)** |

⚠️ Limite **superior** por um lado (nem todo par ambíguo troca vencedor) e possivelmente **inferior**
pelo outro: a query casou empate de DATA, e o código também cai no uuid quando as duas marcas têm
`instante` nulo — caso que a medição pode não ter contado. A regra do código não depende desta
medição para estar certa; a medição serve para dimensionar o custo, e está declarada como
aproximação.

### 5.1 Por que por CLIENTE (achado R3/1)

A revisão 3 marcava a LINHA derivada de uma base ambígua. **A flag desaparecia na deduplicação.** O
motor guarda, por SKU, apenas sua melhor relação com uma base comprada (`useCrossSellEngine.ts:998`)
— e a razão de preço que decide essa "melhor" é justamente a que a referência sorteada altera. O
challenge executou o contraexemplo com os comparadores reais:

| referência sorteada para a base A | melhor relação de X | melhor relação de Y | resultado |
|---|---|---|---|
| 100 | 230/150 = 1,5333 (base B) | 180/150 = 1,2 (base B) | **Y vence — nenhuma flag sobrevive** |
| 200 | 230/200 = 1,15 (base A) | 180/150 = 1,2 (base B) | X vence — flag presente |

Os **mesmos dois SKUs** chegam à persistência nos dois mundos. No primeiro, a RPC permitiria
`eleito = Y` embora trocar exclusivamente os uuids altere o topo. Marcar só a relação que sobreviveu
não basta: a ambiguidade tem de sobreviver às três decisões seguintes — **elegibilidade,
deduplicação e corte**.

**Regra:** a marca é do **cliente**, para o tipo `up_sell`, e é decidida **antes** dessas três
decisões. Ao montar o mapa de preços por (cliente, SKU) — o laço de `useCrossSellEngine.ts:695` — o
motor marca o cliente quando, ao comparar duas marcas do mesmo SKU, o instante é indistinguível
entre `pedidoId` distintos **e os preços diferem**. Um cliente marcado tem TODAS as suas linhas
`up_sell` gravadas com a flag, e o grupo sai `referencia_ambigua` (precedência 1 de §3.3).

`cross_sell` **não** usa preço de referência: seu `pij` é `0,15 × health × engagement × relevance`,
e `relevance` sai de aderência de cluster e regras de associação (`useCrossSellEngine.ts:882`). A
flag é gravada `false` — afirmação verdadeira sobre o tipo, não silêncio.

A alternativa mais seletiva que o challenge admite — marcar só quando o vencedor **não** é invariante
entre as referências admissíveis — exigiria enumerar os mundos possíveis dentro do motor. Fica fora:
mais caro, e a versão conservadora custa 2 clientes de 186.

### 5.2 Coluna, validação e persistência

- **Coluna:** `farmer_recommendations.referencia_ambigua boolean NULL`. **Não** `NOT NULL DEFAULT
  false`: o default afirmaria "não ambígua" sobre 17.316 linhas legadas que ninguém mediu, que é o
  `ausente ≠ zero` da casa dentro do conserto que veio matá-lo. `NULL` = não medido.
- **Payload:** `p_linhas[].referencia_ambigua`, na mesma lista explícita de
  `jsonb_to_recordset` que `ordem` (§6) — sem isso a chave é ignorada **em silêncio**.
- **Validação no writer:** booleano ou ausente. Não-booleano recusa a gravação inteira com SQLSTATE
  nomeada, no mesmo bloco que hoje valida `affinity_score`
  (`farmer_recomendacoes_substituir`, L106-110 da definição de PROD).
- **Leitura fail-closed:** a RPC agrega com `bool_or`, e **`NULL` com `ordem` preenchida conta como
  ambígua**. Esse par só nasce de um produtor que grava rank sem gravar flag — impossível enquanto os
  dois campos entram na mesma versão, e é exatamente por ser impossível que a falha tem de ser
  fechada em vez de suposta. Linha legada (`ordem` nula) cai em `ordem_indisponivel` pela precedência
  2 antes de a flag importar.

## 6. Implantação (critério 3)

1. **Banco** (SQL Editor, `lovable-db-operator`): `ADD COLUMN ordem smallint NULL` · `ADD COLUMN
   referencia_ambigua boolean NULL` (§5.2) · `CREATE OR REPLACE` de `farmer_recomendacoes_substituir`
   (aceita e **valida** os dois: `ordem` nula ou inteiro ≥ 1; `referencia_ambigua` booleana ou
   ausente) · `CREATE` da RPC nova. Pré-flight contra `pg_get_functiondef` da PROD.
2. **Publish**.
3. **Recálculo**, que grava os ranks.
4. **PR de limpeza** derruba a RPC antiga.

A ordem 1→2 é obrigatória: contra o schema velho, o `jsonb_to_recordset` **ignoraria as chaves
novas em silêncio** e nem rank nem flag seriam persistidos, sem erro nenhum.

**Janelas em que a tela segue errada** (o challenge listou, e são reais):

| situação | efeito |
|---|---|
| migration aplicada, front antigo | continua na RPC antiga, elegendo por uuid |
| Publish feito, cliente não adotou o build | o erro persiste até o clique de atualização (`pwa-update.ts:32`) |
| ranks gravados, leitor antigo | a RPC antiga ignora `ordem` e pode eleger outro produto |
| **aba antiga recalcula depois da nova** | grava payload **sem** `ordem`, apagando a cobertura |

A última não é barrada pelo CAS: se a aba antiga lê o head **depois** da geração nova, ela apresenta
o head correto e grava normalmente — o CAS controla concorrência causal, não versão do produtor. E
`FarmerRecommendations.tsx:45` calcula **ao montar**, então não depende de clique consciente.
**O que a entrega faz aqui, dito como o que é** (achado R2/5): um contador **não** torna o writer
fail-closed. São garantias diferentes — o writer segue permitindo que uma geração sem rank
substitua uma com rank; o leitor degrada honestamente para `ordem_indisponivel`; e o contador
apenas torna a regressão **observável**. Isto é **aceitação declarada de perda de cobertura**, não
proteção contra ela, e a revisão 2 a descrevia como se fosse proteção.

⚠️ E a justificativa que eu dei — "rejeitar quebraria a aba antiga inteira" — **não está
demonstrada**: em `useCrossSellEngine.ts:1208` a falha de persistência gera aviso e mantém o
cálculo em memória. O comportamento do build legado efetivamente servido precisa ser **verificado
antes** de a afirmação entrar no PR; até lá ela sai da spec.

O fechamento de verdade, se a exigência for impedir regressão após a adoção, é um **guard de
versão/capacidade do produtor**, verificado atomicamente **antes de expirar linhas** — um produtor
legado não consegue removê-lo. E **nunca copiar ranks antigos para uma geração nova**. O sensor tem
de ser calculado **no servidor** (o produtor legado não sabe emiti-lo) e viver no **log de
execuções** (`20260815181500_farmer_geracao_head_sensor.sql:446`), que tem denominador — como
insumo do head atual ele seria sobrescrito.

### 6.1 O sensor da distribuição — porque a tela pós-entrega NÃO está prevista

§3.2 mede o conjunto **já persistido**. D3 (§3.7) muda a ordenação **antes** do `slice(0,3)`
(`useCrossSellEngine.ts:1037`), logo muda **quais** SKUs são persistidos — e o challenge executou o
contraexemplo: com N=269, `aB=0`, `k=[9,9,9,10]`, os quatro colidem no score arredondado
(`0,0001`); a ordem antiga persiste A/B/C e a reconstrução encontra empate real, a ordem nova
persiste D/A/B e encontra vencedor único. **"Empate entre os produtos persistidos" não demonstra
ausência de vencedor entre os candidatos que o motor verá.** Prever a distribuição exigiria executar
o pipeline TypeScript completo sobre um snapshot coerente — não é derivável do banco.

Então a distribuição **não é prevista, é medida**: o produtor emite, no log de execuções (server-side,
§6), a contagem de grupos por `situacao` e por tipo. Sem esse número, a fase seguinte — dar sinal
novo ao motor de cross-sell — não tem denominador, e "ninguém reclamou" é ausência de dado.

## 7. O que mudou da revisão 1 (challenge Codex)

| # | Achado | Resolução |
|---|---|---|
| 1 | O teste da `relevance` implícita não prova o cancelamento | §1.2 reescrita: evidência é o código; o teste foi retirado como prova e o método que distingue ficou registrado |
| 2 | `empatados` mente com ordem nula | §3.3: `situacao` com 3 estados; `candidatos` conta SKUs distintos |
| 3 | `product_id = NULL` colide com `produto_nao_resolve` | resolvido de vez na R4: identidade separada da eleição (§3.3), e o leitor resolve nome em todo estado (§3.6) |
| 4 | Arbitrariedade a montante do rank | §5: medida (2/186) e declarada, com sensor |
| 5 | Janelas de implantação; §3.4 contradizia §3.5 | §3.5 corrigida; §6 lista as janelas e o risco da aba antiga |
| 6 | Afirmações além da evidência | §1.1 (incidência ≠ dano) e §3.2 (recuperação medida: **104 de 198**, depois de o proxy global ter mentido 198/198) |

### 7.1 Rodada 2 do challenge

A revisão 2 foi de novo reprovada, e com razão em tudo que era verificável:

| # | Achado R2 | Resolução |
|---|---|---|
| 1 | Medir incidência não fecha o contrato: `eleito` ainda podia ser arbitrário na origem | §5: a ambiguidade da referência virou **flag por linha** e bloqueia `eleito` |
| 2 | `k` global pode empatar/inverter na carteira; e heterogeneidade ≠ máximo único | §3.2 remedida: **9/198**, com 4 controles |
| 3 | Singleton com ordem nula não é `eleito`; `[1,2,null]` é incompleta, não ausente; `candidatos` sem conjunto definido | §3.3: 4 estados, e `candidatos` conta conjunto DIFERENTE por estado |
| 4 | Faltava `geracoesExibidas` e o destino da resposta inválida | §3.6: 6º ponto + rejeição INTEIRA + `customer_user_id` na validação |
| 5 | Contador não é fail-closed; "quebraria a aba antiga" não demonstrado | §6: reescrito como aceitação declarada de perda, e a afirmação não demonstrada foi retirada |
| 6 | Afirmações além do medido | §3.2, §5 e §6 corrigidas; §8 rotulada como PLANO de prova |

### 7.2 Rodada 3 do challenge

| # | achado | resposta na revisão 4 |
|---|---|---|
| 1 | a flag por linha **desaparece na dedup** — contraexemplo executado | §5.1: a marca é do CLIENTE, decidida antes de elegibilidade/dedup/corte; §5.2 especifica coluna, validação e persistência |
| 2 | os 4 estados não formam contrato executável: `unico_registrado` exigia nome sem identificador; falta precedência; `ordem_desconhecida` ≠ enum | §3.3 reescrita: **identidade separada da eleição** (`produtos` + `produto_eleito`), 5 estados com PRECEDÊNCIA, nomenclatura única |
| 3 | validador sem invariantes ENTRE campos aceita `empatado` com `candidatos:1` e array vazio; SKU que não resolve ≠ leitura inválida | §3.6.6: tabela de invariantes cruzados; §3.6.3 separa os dois defeitos |
| 4 | 9/198 **não prevê** a tela pós-entrega (D3 muda o conjunto persistido); "todos os empates têm 2" vinha dos 94 | §3.2 rebaixada a descrição do conjunto atual + §6.1 (o sensor); histograma re-medido sobre os **189** (2 em 189/189) e o recorte cross-only (**0 de 52** recuperados) |
| 5 | §8 podia ficar verde sem provar: oráculo contraditório, base SQL sem `p_head_visto`, ramos decisivos em TS | §8 reescrita em 3 camadas, sobre `test-farmer-head-geracao.sh`, com as sabotagens nomeadas e o esperado do interleaving escrito |

O terceiro caminho que o challenge propôs — up-sell ordenado, cross-sell apresentado como **opções
registradas sem prioridade afirmada** — é o que a §3.6 passa a fazer, agora que nomear deixou de
depender de eleger.

## 8. Plano de prova (ainda NÃO executado)

**Onde.** `db/test-farmer-head-geracao.sh`, **não** `db/test-farmer-geracao-vigente.sh` (achado
R3/5). O segundo aplica só a `20260814223445` e testa uma assinatura de
`farmer_recomendacoes_substituir` **sem `p_head_visto`** — que não é a que o front chama
(`useCrossSellEngine.ts:1205`). O primeiro aplica a cadeia `20260814223445` + `20260815181500`, que é
a assinatura real. Provar contra a antiga seria testar código que ninguém executa.

**Três camadas, porque nenhuma cobre a outra.** Semear `ordem` e `referencia_ambigua` à mão no PG
prova armazenamento e leitura — e é cega ao motor perder a flag na dedup, emitir posições distintas
em vez de rank denso, ou omitir o campo ao montar `recRows`. Os ramos decisivos vivem em TypeScript.

### 8.1 PG17 — contrato do banco

- **positivos**: rank denso grava empatados com o mesmo valor · `situacao` nos **cinco** estados,
  respeitando a PRECEDÊNCIA · `candidatos` = tamanho do grupo e `produtos` = quem é nomeado, no caso
  `[A:1, B:1, C:2]` → `produtos=[A,B]`, `candidatos=3` · `produto_eleito` não-nulo **⟺** `eleito` ·
  `[]` na carteira vazia · dois objetos por cliente · ordem parcialmente nula (`[1,2,null]`) →
  `ordem_indisponivel` · **singleton com `ordem` nula → `unico_registrado`** (⚠️ a revisão 3 exigia
  `eleito` nos positivos e `unico_registrado` nos casos do R2 — oráculo contraditório, achado R3/5;
  a precedência de §3.3 resolve: singleton nunca é `eleito`) · `referencia_ambigua` vencendo
  `empatado` **e** `eleito` · `NULL` na flag com `ordem` preenchida → `referencia_ambigua`.
- **negativos**: `ordem = 0` e negativa recusadas com a SQLSTATE nomeada; `referencia_ambigua`
  não-booleana idem — capturando a SQLSTATE esperada e **re-lançando o resto**.
- **RLS**: `SET ROLE authenticated` + GUC; carteira alheia não volta.
- **ACL**: `has_function_privilege` para `PUBLIC` e `anon` nas duas pontas.

### 8.2 Vitest — o produtor e o leitor

- **produtor** (`useCrossSellEngine`): rank **denso** (empatados compartilham o valor; posições
  distintas moveriam o bug do uuid para o índice do array) · a flag de §5.1 sobrevive a
  elegibilidade, dedup e corte · `recRows` carrega os dois campos novos · D3 ordena pelo score **não
  arredondado**.
- **leitor** (`useBundleEngine`): os sete pontos de §3.6 · resposta inválida → `leitura_falhou`
  **inteira** · SKU que não resolve em `empatado` → segue `empatado` com "1 de 2 não identificado",
  **não** vira eleição.
- **fixtures de up-sell com MÚLTIPLAS bases de compra com preços diferentes**: com uma base só, a
  ordem por `premium/referência` coincide com a ordem por `premium` e uma sabotagem passa verde.

### 8.3 Falsificação — uma camada por vez

Linha de base **verde na mesma invocação** (cópia + `LC_ALL`, abortando antes do primeiro `sed`), e
conferindo **contagem e NOMES** dos vermelhos. Sabotagens mínimas, cada uma mirando um ramo que só
ela alcança:

| sabotagem | o que fica vermelho se o teste vale |
|---|---|
| dedup guarda só a flag da relação vencedora | o cliente marcado sai `eleito` (R3/1) |
| D3 volta a ordenar pelo score arredondado | o conjunto persistido muda |
| rank vira posição sequencial em vez de denso | empate vira eleição por índice |
| `recRows` omite `ordem` / `referencia_ambigua` | nada persiste, e o teste que "passava" era cego |
| leitor descarta a linha inválida em vez da resposta | Map parcial apresentado como completo |
| RPC perde a precedência (avalia `empatado` antes de `referencia_ambigua`) | grupo ambíguo afirma igualdade medida |

### 8.4 O interleaving legado — o esperado escrito

"Nova grava → antiga lê o head novo → antiga tenta gravar": sob a decisão de §6, **a gravação antiga
é ACEITA**. O leitor degrada para `ordem_indisponivel` e o servidor registra a perda de cobertura no
log de execuções. Um teste esperando recusa estaria provando outra decisão — e passaria a reprovar o
código correto.

## 9. O que esta entrega NÃO fecha (declarado)

- **A precedência entre tipos continua sem regra comercial.** D1 dissolve a comparação; não a
  resolve.
- **Os 189 empates REAIS do cross-sell** (95,5% dos grupos empatados; **52 de 52** nos clientes
  cross-only, §3.2) continuam sem vencedor — e é correto que continuem: o motor não tem sinal que os
  distinga. Fechá-los exige **sinal novo** (margem, giro, recência do SKU no cliente), que é trabalho
  de motor, não de ordenação. O que a entrega faz é parar de **fingir** que há vencedor ali.
- **A distribuição da tela depois desta entrega não está prevista** (§6.1): D3 muda o conjunto
  persistido, e prever exigiria executar o pipeline TS sobre um snapshot coerente. Quem responde é o
  sensor server-side, e ele é entregue junto.
- **A via do WhatsApp e o corte top-3/top-2** (§4).
- **A ambiguidade da referência de preço não é CONSERTADA** (§5): ela passa a ser propagada por
  cliente e a bloquear eleição — o conserto seria dar a `preco-referencia.ts` um critério que não
  caia em uuid, e isso é spec própria.
- **`p_ij` é 0 em 645 de 714 linhas cross-sell** (`Math.round(0,0002 × 1000)/10 = 0`): o vendedor lê
  "0,0%". Mesma quantização, outra coluna, outro consumidor.
- **Moeda comum em R$** (§1.3): sem substrato hoje.
- **O sinal do motor de cross-sell é grosso, e agora há evidência dimensionada disso**: 189 de 198
  grupos têm `relevance` EXATAMENTE igual entre os candidatos do topo, todos de tamanho 2. Dar sinal
  novo é o conserto da CAUSA — spec própria, com esta medição como ponto de partida e o sensor de
  §6.1 como denominador. Esta entrega trata o sintoma: para de apresentar o sorteio como veredicto.
