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

**Quanto isso recupera, medido — e o primeiro número estava errado.** Dentro de um cliente,
`relevance = 0,4·k/N + 0,6·aB`, com `k` = compradores distintos do SKU **na carteira** (N=269
clientes, medido). Eu primeiro usei `k` GLOBAL como proxy e obtive "198 de 198 recuperáveis". O `k`
de carteira **inverte parte do resultado**:

| | n | % dos 198 |
|---|---|---|
| grupos cross-sell empatados no topo | 198 | 100% |
| `k` de carteira DIFERE ⇒ recuperável pelo score não-arredondado | **104** | **52,5%** |
| `k` de carteira IGUAL | 94 | 47,5% |
| desses 94, salvos por `assocBoost` diferente | **0** | — |
| **empate REAL** (mesmo `k` **e** mesmo `aB` ⇒ mesma `relevance`) | **94** | **47,5%** |

⇒ Sobre os 238 grupos cross-sell: 40 já decididos pelo score · 104 recuperados pelo rank ·
**94 (39,5%) vão exibir "N produtos igualmente indicados"**.

Esses 94 são **indistinguíveis para o motor** — mesma aderência de carteira, nenhuma regra de
associação. `empatado` é a resposta verdadeira, e consertá-los seria dar **sinal novo** ao motor,
não ordenar melhor. Fica declarado em §9.

⚠️ Lição de método, e ela quase passou: um proxy pode ser *fortemente* correlacionado e ainda
inverter o veredicto. `k` global distinto NÃO implica `k` de carteira distinto — a carteira é 269
de milhares de clientes, e SKUs que se separam na base inteira colidem no recorte.
(`cluster_volume_estimate` também não serve: é `1` em 714 de 714 linhas, no piso do `max(1,…)`.)

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
| `eleito` | ordem conhecida em todo o grupo **e** um único candidato no topo | decidido por sinal |
| `empatado` | ordem conhecida em todo o grupo **e** ≥2 candidatos no topo | igualdade MEDIDA |
| `ordem_desconhecida` | **qualquer** `ordem` nula no grupo com ≥2 candidatos | ninguém mediu |

Um grupo de **um único candidato** é `eleito` mesmo com `ordem` nula: não há escolha a fazer, e
chamar isso de empate seria a mentira simétrica. `candidatos` conta **SKUs distintos** (`count
(DISTINCT product_id)`), não linhas — "N produtos" exige unicidade por produto.

O caso `[1, 2, null]` cai em `ordem_desconhecida` por fail-closed: as ordens conhecidas mantêm sua
relação entre si, mas nada situa a linha nula, e afirmar o vencedor exigiria descartá-la.

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

Os 1.083 pendentes de 21/08 nascem com `ordem` nula ⇒ `situacao = 'ordem_desconhecida'` e a tela diz
"ordenação indisponível — N recomendações registradas".

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
5. **Validação em runtime da resposta**: tipo reconhecido, `candidatos` inteiro ≥1, sem duplicata
   `(cliente,tipo)`, combinação `situacao`×`product_id` válida. O cast atual para
   `MelhorIndividualRow[]` não valida nada.

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

É limite **superior**: nem todo par ambíguo troca vencedor. A 1,1% dos clientes, propagar a
ambiguidade até o contrato da RPC não se paga nesta entrega — mas **declarar** é obrigatório, e a
entrega inclui um sensor que conta pares ambíguos por execução, para que o número deixe de depender
de alguém lembrar de medir. Se ele subir, a propagação vira trabalho próprio.

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
⇒ a validação de `ordem` no writer **não pode** rejeitar o payload legado (quebraria a aba antiga
inteira); o que a entrega adiciona é um **contador de gerações sem `ordem`** no head, para a janela
ser observável em vez de suposta.

## 7. O que mudou da revisão 1 (challenge Codex)

| # | Achado | Resolução |
|---|---|---|
| 1 | O teste da `relevance` implícita não prova o cancelamento | §1.2 reescrita: evidência é o código; o teste foi retirado como prova e o método que distingue ficou registrado |
| 2 | `empatados` mente com ordem nula | §3.3: `situacao` com 3 estados; `candidatos` conta SKUs distintos |
| 3 | `product_id = NULL` colide com `produto_nao_resolve` | §3.6: cinco pontos do leitor, com a ordem das decisões explícita |
| 4 | Arbitrariedade a montante do rank | §5: medida (2/186) e declarada, com sensor |
| 5 | Janelas de implantação; §3.4 contradizia §3.5 | §3.5 corrigida; §6 lista as janelas e o risco da aba antiga |
| 6 | Afirmações além da evidência | §1.1 (incidência ≠ dano) e §3.2 (recuperação medida: **104 de 198**, depois de o proxy global ter mentido 198/198) |

## 8. Prova

Harness PG17 estendendo `db/test-farmer-geracao-vigente.sh` (hoje 31 asserts + 4 falsificações):

- **positivos**: rank denso grava empatados com o mesmo valor · `situacao` nos três estados ·
  `candidatos` conta SKUs distintos · `product_id` nulo fora de `eleito` · grupo de 1 candidato com
  `ordem` nula sai `eleito` · `[]` na carteira vazia · dois objetos por cliente.
- **negativos**: `ordem = 0` e negativa recusadas com a SQLSTATE nomeada, re-lançando o resto.
- **RLS**: `SET ROLE authenticated` + GUC; carteira alheia não volta.
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
