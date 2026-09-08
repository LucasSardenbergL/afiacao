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

⇒ Sobre os 238 grupos cross-sell: 40 já decididos pelo score + **9** recuperados = **49 eleitos
(20,6%)**; **189 (79,4%) exibem empate**.

**O que isso muda na proposta de valor, dito sem maquiagem:** o rank do cross-sell quase não
ELEGE — ele faz a tela **parar de mentir**. A causa é o sinal do motor ser grosso: `k ∈ [9,22]`
sobre N=269, com `aB = 0` na maioria, produz colisão EXATA de `relevance`. Não é arredondamento,
não é ordenação: é ausência de informação, e nenhuma mudança de `ORDER BY` a cria.

O rank continua necessário — mas pelo **up-sell**, onde o score não carrega produto nenhum e a
chave do #1837 (razão de preço, contínua) discrimina de verdade. Incluir o cross-sell na mesma
coluna é quase de graça e remove a dependência do arredondamento como proxy de empate.

**Nada disto toca `affinity_score` nem `p_ij`.**

### 3.3 RPC `farmer_melhores_individuais_por_cliente(uuid)` (nome novo — §3.4)

Devolve `jsonb` com até **dois** objetos por cliente:

```
customer_user_id · recommendation_type · product_id · affinity_score · run_id
                 · situacao · candidatos · produtos_empatados
```

⚠️ **A revisão 1 tinha UM campo `empatados` e ele MENTIA.** Com `ordem` nula em todo o grupo, ele
diria "2 produtos igualmente indicados" — afirmando igualdade **medida** onde houve
**desconhecimento**. É o `ausente ≠ zero` da casa reintroduzido dentro do conserto que veio matá-lo.
São dois estados diferentes e passam a ter nomes diferentes:

| `situacao` | condição | significado |
|---|---|---|
| `eleito` | ordem conhecida em TODO o grupo · máximo ÚNICO · referência não-ambígua | decidido por sinal |
| `empatado` | ordem conhecida em TODO o grupo · ≥2 candidatos no máximo | igualdade MEDIDA |
| `unico_registrado` | grupo de UM candidato | identificável, mas nada foi ordenado |
| `ordem_indisponivel` | ≥2 candidatos e QUALQUER `ordem` nula | ordenação ausente ou incompleta |

⚠️ **`unico_registrado` existe porque `eleito` mentiria** (achado R2/3). Um grupo de um candidato
com `ordem` nula não é empate — mas também não foi decidido por sinal de ordenação nenhum. Ser a
única recomendação registrada permite identificá-la; não diz nada sobre a qualidade da escolha que
a produziu. Colapsar os dois em `eleito` seria a mentira simétrica à do campo único da revisão 1.

⚠️ **`ordem_indisponivel` cobre DOIS casos e o rótulo não afirma mais do que sabe**: `[null,null]`
é ordenação **ausente**; `[1,2,null]` é ordenação **incompleta** — as ordens conhecidas mantêm sua
relação, mas nada situa a linha nula, e eleger exigiria descartá-la. Nos dois a resposta honesta é
a mesma ("não dá para ordenar este grupo"), então o estado é um só; o que não se pode é chamar
qualquer um deles de "ninguém mediu", que era a redação anterior.

**`candidatos` conta conjuntos DIFERENTES por estado**, e isso é explícito no contrato porque
contar o grupo inteiro em `empatado` seria falso (achado R2/3): em `[A:1, B:1, C:2]` há **2**
empatados, não 3.

| estado | `candidatos` conta |
|---|---|
| `empatado` | SKUs distintos **no topo** |
| `ordem_indisponivel` | SKUs distintos **registrados no grupo** |
| `eleito` · `unico_registrado` | 1 |

**Guard estrutural: `product_id` só é não-nulo quando `situacao = 'eleito'`.** Sem eleição por
sinal, não sai vencedor — impossível renderizar a moeda por descuido.

**`produtos_empatados` (array de SKUs) é preenchido SÓ em `empatado`** — e a assimetria com
`ordem_desconhecida` é o ponto: só listamos produtos quando a igualdade foi **medida**. Em
`ordem_desconhecida` sai apenas a contagem, porque afirmar "estes são igualmente indicados" sobre
linhas cuja ordem ninguém conhece seria a mesma mentira do campo único que a revisão 1 tinha.

Decisão de exibir a LISTA (delegada pelo founder, decidida por medição): os 94 empates reais têm
**tamanho exatamente 2 — todos os 94**. Listar dois nomes ocupa o mesmo espaço que "2 produtos
igualmente indicados" e é estritamente mais útil: o vendedor conhece o cliente e desempata com o
que o motor não sabe. O teto é estrutural — o corte do motor persiste no máximo 3 cross-sell por
cliente, então a lista nunca passa de 3.

Preservados da RPC atual e pelos mesmos motivos: `coalesce(…, '[]'::jsonb)`, `SECURITY INVOKER`,
`REVOKE`/`GRANT` nomeando as roles.

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

O leitor muda em cinco pontos, e quatro deles são armadilhas que o challenge apontou:

1. **A chave do Map passa a incluir o tipo** (`useBundleEngine.ts:844`) — hoje é uma linha por
   cliente, e o segundo objeto sobrescreveria o primeiro.
2. **A decisão sobre `situacao` acontece ANTES de consultar `productMap`.** Hoje `pid == null` cai
   direto em `produto_nao_resolve` (`useBundleEngine.ts:1050`): sem esta ordem, todo empate viraria
   "o SKU sumiu do catálogo". Só `eleito` tenta resolver SKU.
3. **O sensor de resolução** (`useBundleEngine.ts:1163`) não pode contar `product_id` nulo
   deliberado como falha de catálogo — fabricaria deterioração.
4. **O filtro de inclusão do cartão** (`useBundleEngine.ts:1073`) passa a omitir o cliente só quando
   **ambos** os tipos são `nenhum`.
5. **Validação em runtime da resposta**: `customer_user_id` presente, tipo reconhecido,
   `candidatos` inteiro ≥1, sem duplicata `(cliente,tipo)`, combinação `situacao`×`product_id`
   válida. O cast atual para `MelhorIndividualRow[]` não valida nada. **A resposta inválida é
   rejeitada INTEIRA como `leitura_falhou`, preservando a causa** — validar-e-descartar linhas
   transformaria falha em ausência e entregaria um Map parcial apresentado como completo (achado
   R2/4). Sem a checagem de `customer_user_id` as demais passam e a linha some na consulta pela
   chave, que é a mesma falha por outra porta.
6. **`geracoesExibidas`** (`useBundleEngine.ts:1057`) só recebe `run_id` quando o produto resolve.
   Com os estados novos, cartões exibiriam empates e ordens indisponíveis de gerações diferentes
   sem alimentar o canário — a contagem passa a acompanhar **todo estado exibido**,
   independentemente de o SKU resolver.

**Preservar** (o challenge listou, e nenhum é consequência automática do desenho): o cartão
continua aparecendo quando há bundle, mesmo com os dois individuais em `nenhum`; o aviso do cartão
recolhido (`CustomerBundleCard.tsx:68`), hoje dependente do estado individual único; e a proibição
de comparar `ordem` de `run_id` diferentes dentro de uma mesma eleição.

O cartão ganha duas células rotuladas, cada uma com:

| estado | mostra |
|---|---|
| `eleito` + SKU resolve | nome do produto |
| `empatado` | "Igualmente indicados: A, B" (os nomes; sempre 2 hoje, teto 3) |
| `ordem_desconhecida` | "Ordenação indisponível — N recomendações registradas" |
| `nenhum` | — |
| `indisponivel` | rótulo + motivo (leitura falhou · SKU fora do catálogo) |

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

## 5. Ambiguidade a montante do rank — declarada e medida

`compararRecencia` (`preco-referencia.ts:114`) desempata por `pedidoId` (uuid) quando as datas
empatam. Isso escolhe o preço de **referência**, que é a chave primária da ordem do up-sell — logo
um rank pode ser numericamente único (`situacao = 'eleito'`) e ainda carregar uma decisão arbitrária
na origem. O challenge executou os helpers reais trocando só os uuids e o vencedor mudou de Y para X.

**Incidência, medida agora** (o challenge a declarou desconhecida):

| | n |
|---|---|
| pares (cliente,SKU) com preço utilizável | 13.290 |
| topo com empate de data entre pedidos DISTINTOS | 157 |
| **desses, com preços distintos ⇒ o uuid muda a referência** | **23 (0,17%)** |
| clientes atingidos | 14 |
| **∩ com os 186 clientes de up-sell vivo** | **2 (1,1%)** |

É limite **superior**: nem todo par ambíguo troca vencedor. Mas **incidência medida não fecha
falha de contrato** (achado R2/1): um único caso basta para que `eleito` — que afirma "decidido por
sinal" — esteja errado, e o Codex executou os helpers reais trocando só os uuids, obtendo topo
numericamente único nos DOIS mundos, com vencedores diferentes.

**Por isso a ambiguidade entra no contrato, não num sensor agregado.** Um sensor não permite ao
consumidor distinguir os casos afetados; a flag permite. O motor já tem o dado no instante em que
escolhe a referência: quando o topo por `instante` está empatado entre pedidos DISTINTOS **com
preços diferentes**, o candidato up-sell derivado dela nasce marcado, e o grupo não pode sair
`eleito` — cai em `ordem_indisponivel`. Custo: um booleano por linha, decidido onde a informação
já existe. A alternativa que o Codex também aceitava — rebaixar `eleito` para "topo único do rank
persistido" — foi descartada: ela conserta o texto e deixa o consumidor sem como distinguir.

## 6. Implantação (critério 3)

1. **Banco** (SQL Editor, `lovable-db-operator`): `ADD COLUMN ordem` · `CREATE OR REPLACE` de
   `farmer_recomendacoes_substituir` (aceita e **valida** `ordem`: nula, ou inteiro ≥ 1) · `CREATE`
   da RPC nova. Pré-flight contra `pg_get_functiondef` da PROD.
2. **Publish**.
3. **Recálculo**, que grava os ranks.
4. **PR de limpeza** derruba a RPC antiga.

A ordem 1→2 é obrigatória: contra o schema velho, o `jsonb_to_recordset` **ignoraria a chave
`ordem` em silêncio** e nenhum rank seria persistido, sem erro nenhum.

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

## 7. O que mudou da revisão 1 (challenge Codex)

| # | Achado | Resolução |
|---|---|---|
| 1 | O teste da `relevance` implícita não prova o cancelamento | §1.2 reescrita: evidência é o código; o teste foi retirado como prova e o método que distingue ficou registrado |
| 2 | `empatados` mente com ordem nula | §3.3: `situacao` com 3 estados; `candidatos` conta SKUs distintos |
| 3 | `product_id = NULL` colide com `produto_nao_resolve` | §3.6: cinco pontos do leitor, com a ordem das decisões explícita |
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

## 8. Plano de prova (ainda NÃO executado)

Harness PG17 estendendo `db/test-farmer-geracao-vigente.sh` (hoje 31 asserts + 4 falsificações):

- **positivos**: rank denso grava empatados com o mesmo valor · `situacao` nos três estados ·
  `candidatos` conta SKUs distintos · `product_id` nulo fora de `eleito` · grupo de 1 candidato com
  `ordem` nula sai `eleito` · `[]` na carteira vazia · dois objetos por cliente.
- **negativos**: `ordem = 0` e negativa recusadas com a SQLSTATE nomeada, re-lançando o resto.
- **RLS**: `SET ROLE authenticated` + GUC; carteira alheia não volta.
- **exigidos pelo R2**: máximo PARCIALMENTE empatado (`[A:1,B:1,C:2]`) · ordem parcialmente nula
  (`[1,2,null]`) · singleton com ordem nula saindo `unico_registrado` · falha de validação chegando
  ao cartão como `leitura_falhou` (e não como Map parcial) · o interleaving "novo grava → antigo lê
  head novo → antigo tenta gravar" · referência ambígua bloqueando `eleito`.
- **falsificação**: uma camada por vez, com linha de base **verde na mesma invocação**, conferindo
  **contagem e NOMES** dos vermelhos.

⚠️ **Armadilha herdada e específica**: `preco-de-referencia-escolhido-por-uuid.md` registra que o
Codex removeu a referência da chave de ordenação e **12 testes seguiram verdes**, porque a fixture
tinha **uma** base comprada — com uma base só, `premium/ref` ordena igual a `premium`. As fixtures
de up-sell aqui terão **múltiplas bases com preços diferentes**, e haverá sabotagem dedicada a
provar que essa propriedade é medida.

## 9. O que esta entrega NÃO fecha (declarado)

- **A precedência entre tipos continua sem regra comercial.** D1 dissolve a comparação; não a
  resolve.
- **Os 94 empates REAIS do cross-sell** (39,5% dos grupos) continuam sem vencedor — e é correto que
  continuem: o motor não tem sinal que os distinga. Fechá-los exige **sinal novo** (margem, giro,
  recência do SKU no cliente), que é trabalho de motor, não de ordenação. O que a entrega faz é
  parar de **fingir** que há vencedor ali.
- **A via do WhatsApp e o corte top-3/top-2** (§4).
- **A ambiguidade da referência de preço** (§5) — declarada e sensoreada, não propagada.
- **`p_ij` é 0 em 645 de 714 linhas cross-sell** (`Math.round(0,0002 × 1000)/10 = 0`): o vendedor lê
  "0,0%". Mesma quantização, outra coluna, outro consumidor.
- **Moeda comum em R$** (§1.3): sem substrato hoje.
- **O sinal do motor de cross-sell é grosso, e agora há evidência dimensionada disso**: 189 de 198
  grupos têm `relevance` EXATAMENTE igual entre os candidatos do topo. Dar sinal novo (margem,
  giro, recência do SKU no cliente) é o conserto da CAUSA — spec própria, com esta medição como
  ponto de partida. Esta entrega trata o sintoma: para de apresentar o sorteio como veredicto.
