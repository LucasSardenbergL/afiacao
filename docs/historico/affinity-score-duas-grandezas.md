# `affinity_score` carrega DUAS grandezas — e dois consumidores as comparam como se fossem uma

> Medido em produção via `psql-ro` em **07/09/2026** (1.083 recomendações `pendente`: 714 `cross_sell` + 369 `up_sell`).
> Achado original: leitura de código no #1837, que o declarou e NÃO pôde fechá-lo. Este documento é a MEDIÇÃO que faltava.

## O que se sabia (e por que ficou aberto)

`farmer_recommendations.affinity_score` recebe valores de dois motores diferentes. O comentário de
`melhorAfinidade` (`useCrossSellEngine.ts`) já dizia que eles não são comensuráveis — "o `pij` do up-sell
já carrega o fator 0,8 e sai de outra base histórica". O #1837 consertou a ORDEM do up-sell em memória
(`src/lib/farmer/upsell-ordem.ts`) mas não pôde gravá-la no score: qualquer codificação monótona
(`1,1/r`, `(1,1/r)²`, exponencial) dá a mesma ordem local e resultados DIFERENTES nos consumidores que
leem a magnitude. Escolher uma seria inventar score.

O que não se sabia era o TAMANHO do efeito. Sem isso não dava para escolher entre filtrar, declarar
precedência ou pagar uma coluna de rank.

## O que a medição mostrou

### 1. As faixas quase não se tocam — não é ranking ruim, é grandeza errada

| tipo | n | mín | p25 | mediana | p75 | máx |
|---|---|---|---|---|---|---|
| `cross_sell` | 714 | 0,0001 | 0,0001 | **0,0002** | 0,0003 | 0,0138 |
| `up_sell` | 369 | **0,0024** | 0,0026 | 0,0036 | 0,0046 | 0,0146 |

O **mínimo** do up-sell (0,0024) é 8× o **p75** do cross-sell (0,0003). Só **17 das 714** cross-sell
(2,4%) alcançam o piso do up-sell. Comparar as duas por `>` não ordena mérito: ordena escala.

### 2. Na RPC, o `ORDER BY affinity_score` é um no-op — o tipo decide sozinho

`farmer_melhor_individual_por_cliente` elege o "melhor produto individual" de cada cliente sem filtrar
`recommendation_type`. Resultado por par (farmer, cliente):

- vencedor `up_sell`: **186** · vencedor `cross_sell`: **52**
- entre os pares que têm **os DOIS** tipos pendentes, `up_sell` vence **186 de 186 = 100%**
- os 52 vencedores `cross_sell` são **exatamente** os pares que não têm nenhum `up_sell`

Ou seja: **o TIPO do vencedor é 100% previsto por "existe up-sell?"**. A RPC apresenta como veredicto
de comparação uma **precedência de tipo não declarada**, nascida de artefato de escala.

⚠️ **Não extrapole além disto** (trimado pelo challenge Codex): isto é uma fotografia, não uma
propriedade permanente dos motores; e não diz que o score nunca decide NADA — nos 52 pares sem
up-sell ele ainda escolhe entre produtos cross-sell. O que está medido é o eixo ENTRE tipos.

### 3. Dentro do `up_sell` o desempate é uma MOEDA

| eixo | clientes com 2 ofertas up-sell | empate TOTAL |
|---|---|---|
| `affinity_score` | 183 | **183 (100%)** |
| `updated_at` | 183 | **183 (100%)** |
| `created_at` | 183 | **183 (100%)** |

O `ORDER BY` da RPC é `affinity_score DESC, updated_at DESC, id DESC`. Com os três primeiros eixos
empatados em 100% dos casos, quem elege o "melhor individual" é o **`id` — um uuid v4** (medido: 100%
das 1.083 linhas pendentes são v4). A ordem que o #1837 calculou (razão de preço, depois popularidade)
é descartada para **todos** os 183 clientes, e substituída por um critério sem relação com mérito.

⚠️ Precisão de vocabulário (challenge Codex): o desempate é **arbitrário mas ESTÁVEL** enquanto as
linhas forem as mesmas — não é sorteio a cada leitura. O efeito prático é outro: **regerar as
recomendações pode trocar o vencedor sem que nada comercial tenha mudado.**

⚠️ E **não** afirmamos que este é "o defeito maior" que o eixo entre-tipos. São defeitos de naturezas
diferentes — a incomensurabilidade decide a FAMÍLIA da oferta, o desempate decide QUAL produto dela
aparece — e frequência de ocorrência não mede dano comercial. Os dois ficam registrados separados.

⚠️ **Consequência para quem for consertar:** `created_at` NÃO recupera a ordem de inserção — está
empatado nos mesmos 183. Não há conserto de graça por coluna existente; persistir a ordem exige coluna
de rank.

### 4. No preview do WhatsApp, a seção "experimente também" era majoritariamente up-sell

`usePropostaPreview` lia `affinity_score` filtrando só `status='pendente'`, e `selecionarCrossSell`
ordenava por ele para montar o top-2 da seção — que é literalmente cross-sell.

- **369 de 476** vagas do top-2 (77,5%) eram `up_sell`
- **183 dos 238** clientes (77%) recebiam a seção **100% up-sell**; 3 mista; 52 100% cross-sell
- o cliente via, como "experimente também", a versão **mais cara do que ele já compra** — não o
  produto complementar que a seção promete

### 5. Filtrar o preview por tipo custa ZERO cliente

Composição dos clientes com recomendação pendente: **186 com ambos os tipos**, **52 só cross-sell**,
**0 só up-sell**.

Contar o tipo, porém, ainda não prova que a seção sobrevive: o candidato precisa mapear para um
`omie_products` **ativo** antes de chegar ao cliente. Medido com o join:

| | clientes |
|---|---|
| têm seção viva HOJE | **238** |
| têm seção viva APÓS o filtro | **238** |
| **perderiam a seção** | **0** |
| têm **2+ SKUs cross-sell ativos** distintos (a seção quer 2) | **238** |

⚠️ **Limite declarado da medição:** ela não simula a exclusão do que já está na cesta (depende do
histórico de pedidos de cada cliente, reconstruído em runtime). Esse filtro é **simétrico** — vale
igual para up-sell hoje —, então ele não é razão para preferir o estado anterior; mas "0 perdem"
está medido sobre tipo + `ativo`, não sobre tipo + `ativo` + cesta.

## Decisão

**Preview: filtrado (entregue).** A medição mostra custo zero em cobertura E em preenchimento — é o
caso raro em que precisão>recall não cobra recall nenhum. O filtro entra em `buildCrossSellCandidatos`,
ou seja **antes do dedupe por SKU**: fosse depois, uma linha up-sell poderia vencer o dedupe de um SKU
e levar junto a oportunidade cross-sell daquele mesmo SKU (achado do challenge Codex). O `slice(0,2)`
já era a última operação, depois de `ativo` e da exclusão da cesta — vagas não são consumidas por
candidato inválido.

⚠️ **O modo de falha que quase foi entregue** (challenge Codex, gpt-6-astra/max): `.eq()` na query
**não** acrescenta a coluna ao `.select()`. Com o helper exigindo `recommendation_type === 'cross_sell'`
e a query projetando só `product_id, affinity_score, status`, o campo chegaria `undefined`, o helper
descartaria TUDO e a seção iria a **zero para os 238 clientes** — em silêncio, e com o teste do helper
VERDE, porque a fixture fornece o campo que a query esquecera. Conserto: a coluna entra no `select`, e
`recommendation_type` ausente é **erro explícito** no helper, não "não é cross-sell" (money-path §6 —
helper defensivo tem de expor a falha no contrato).

**RPC: NÃO consertada neste PR.** O argumento que sustenta isso não é "meio-conserto é pior que
nenhum" — a permanência de um defeito não invalida a correção de outro, e o challenge derrubou essa
formulação. O argumento que fica de pé é mais simples: **não existe regra comercial que autorize
privilegiar up-sell sobre cross-sell.** Declarar a precedência explícita apenas reproduziria um viés
OBSERVADO, e viés observado não estabelece a regra. Filtrar por tipo, por sua vez, amputaria o
contrafactual — up-sell é oferta individual legítima, e a RPC serve exatamente "vale mais vender UM
produto do que o bundle?".

⚠️ **E "é só pôr coluna de rank" está incompleto** (challenge Codex): se cada motor escreve o SEU
rank, `up_sell rank=1` e `cross_sell rank=1` seguem **sem comparação definida** — o eixo entre-tipos
continua aberto. Rank persistido resolve a ordem DENTRO do tipo; não define "melhor" ENTRE tipos. Essa
definição é decisão de produto e precede a migration.

**Custo aceito enquanto isso, dito por extenso:** a tela do bundle segue exibindo uma seleção sem
critério válido entre tipos, e como ela mostra **só o nome do produto**, a limitação é invisível para
quem avalia. Isso é dívida declarada, não defeito desconhecido.

### Critérios de aceite para a entrega da RPC (o que "não perder o conserto" exige)

1. **Definir "melhor" entre tipos** — política explícita comparando o conjunto de ofertas individuais.
   Sem isso, qualquer ordenação é arbitrária, com ou sem coluna nova.
2. **Ordenação justificável DENTRO de cada tipo** (para up-sell, a do #1837: razão de preço, depois
   popularidade).
3. Se houver rank persistido: **escopo** do rank, tratamento dos **registros existentes**, e a
   **sequência de implantação** entre banco → escritores → leitor (migration manual no Lovable não
   auto-aplica; leitor novo sobre dado velho lê `NULL`).
4. Os **dois defeitos registrados separados** (entre-tipos e desempate dentro do tipo) — consertar um
   não fecha o outro.
5. As consultas desta medição são reproduzíveis e a fotografia é datada (07/09/2026), com filtros e
   denominadores explícitos, para que a re-medição na entrega seja comparável.

## Lição durável

**Uma coluna que recebe valores de dois motores não é um score — é duas colunas empilhadas.** O sintoma
não aparece como erro: aparece como um `ORDER BY` que roda, retorna linha e parece decidir. Aqui ele
tinha 100% de concordância com uma regra que ninguém escreveu ("up-sell primeiro") e 0% de dependência
do número que dizia estar comparando.

E o corolário de método: **empate não é detalhe de desempate, é ausência de sinal.** Quando o 1º, 2º e
3º eixos do `ORDER BY` empatam em 100% dos casos, o resultado não é "quase certo" — é sorteado, e a
tela apresenta o sorteio como veredicto. Antes de aceitar um `ORDER BY` de money-path, meça quantos
casos chegam vivos ao ÚLTIMO eixo.
