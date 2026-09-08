# A RPC do "melhor individual" elege por moeda em 98,7% dos casos — desenho do conserto

> Continuação de `docs/historico/affinity-score-duas-grandezas.md` (#2350), que mediu o defeito e
> deixou a RPC de fora **de propósito**, com 5 critérios de aceite. Este é o desenho que os atende.
> Re-medição em prod: 07/09/2026, `psql-ro`, geração de 21/08/2026, 1.083 recomendações pendentes.

> 🚧 **STATUS: REPROVADA NO CHALLENGE — não implementar esta versão.** Challenge Codex
> (`gpt-6-astra`, `max`, 522 s, 159k tokens) derrubou quatro peças, todas confirmadas no código:
> (a) o teste da `relevance` implícita é fraco — como o up-sell vence os 186 pares, o limite
> superior do clamp passa por construção e não testa nada; (b) `empatados` **mente** quando a
> `ordem` é nula: "N produtos igualmente indicados" afirma igualdade MEDIDA onde houve
> desconhecimento (é `ausente ≠ zero` com outra roupa); (c) `product_id = NULL` colide com o ramo
> `produto_nao_resolve` do leitor atual (`useBundleEngine.ts:1050`), virando "SKU sumiu" em vez de
> "empatou"; (d) há escolha arbitrária **a montante** do rank — `compararRecencia` desempata por
> `pedidoId` (uuid) quando as datas empatam, e o vencedor do up-sell muda sem que o rank deixe de
> parecer inequívoco. Além disso a RPC **não** é fronteira que toda via cruza: o preview do
> WhatsApp lê a tabela direto e reordena pelo score arredondado. Revisão em curso.


## 1. O que a re-medição acrescentou à fotografia do #2350

A fotografia do doc **reproduziu exatamente** (714 cross-sell + 369 up-sell, mesmas faixas, 186/186
up-sell vencendo entre pares com os dois tipos, 52 vencedores cross-sell = exatamente os pares sem
up-sell). Duas coisas são novas, e as duas mudam o desenho.

### 1.1 O defeito do desempate é maior do que o medido — e engole o outro

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

Consequência de desenho: **declarar política entre tipos e parar aí consertaria ~0%** do que chega
à tela. O eixo dominante é o desempate, não a precedência.

Causa direta, no cross-sell: `affinityScore: Math.round(score * 10000) / 10000`. A `relevance`
varia na casa de 1e-6 e o arredondamento é 1e-4 — restam **32 valores distintos em 714 linhas**.
A ordem existe no cálculo e morre na gravação.

### 1.2 Não é "artefato de escala" — é um limiar bem definido, e ele quase virou

Os dois motores computam `P(conversão)` do MESMO cliente e compartilham os fatores `health/100` e
`engagement`, que **cancelam** na comparação:

```
cross: pij = 0,15 × (health/100) × engagement × relevance    relevance = clamp(cA·0,4 + aB·0,6, 0,01, 1,0)
up:    pij = 0,10 × (health/100) × engagement × 0,8

up > cross  ⟺  0,08 > 0,15 × relevance  ⟺  relevance < 0,5333
```

**Teste falsificável** (o que separa isto de uma história plausível): se o cancelamento vale, a
`relevance` implícita `(max_cross/max_up)/1,875` tem de cair dentro do `clamp` do código. Medido
nos 186 pares com os dois tipos: mín **0,0148** · mediana **0,0338** · máx **0,5041** ·
**0 de 186 fora de [0,01 , 1,0]**. Cair 186/186 dentro do intervalo exato seria coincidência
absurda se a álgebra estivesse errada.

Isto **corrige o vocabulário** do #2350 em dois pontos:

- as grandezas não são incomensuráveis "por base histórica diferente" — os termos de cliente são
  literalmente os mesmos e se cancelam;
- a precedência não é **estrutural**, é **contingente**: o máximo observado (0,5041) ficou a **5,5%**
  do limiar (0,5333). Uma carteira com `assocBoost` um pouco maior faz cross-sell vencer.

A assimetria real é outra, e é a que importa para o produto: **o score do cross-sell é descontado
por um termo de aderência ao PRODUTO; o do up-sell não tem termo de produto nenhum** (o `0,8` é
constante para todo candidato). O número do up-sell não estima o produto — estima o cliente. Comparar
os dois é comparar "P(compra ESTE complementar)" com "P(compra ALGO mais caro)": erro de categoria,
não de escala.

### 1.3 Substrato para "moeda comum" não existe hoje

`lie` e `m_ij`: **0 de 17.316 linhas** populadas (colunas mortas, como `best_individual_lie`).
Comparar em R$ exigiria reintroduzir margem no motor — removida do browser de propósito no #1837.
Fica registrado como caminho possível, fora desta entrega.

## 2. As decisões (do founder, 07/09/2026)

| # | Decisão | Critério que atende |
|---|---|---|
| D1 | A RPC devolve o **melhor de CADA tipo**, sem compará-los | 1 e 5 |
| D2 | Eleição não decidida por sinal → **não elege**; diz que empatou | 4 |
| D3 | A ordem em MEMÓRIA do cross-sell entra na mesma entrega | — |
| D4 | O cartão ganha **duas células rotuladas** | — |

**D1 dissolve a comparação em vez de inventá-la.** É a única saída que não viola o critério 5:
declarar `up_sell > cross_sell` reproduziria um viés observado, e nenhuma regra comercial autoriza
a precedência. Não escolher é a resposta honesta quando não há critério — `precisão > recall`
aplicado à ORDEM, não ao conteúdo.

## 3. O desenho

### 3.1 `farmer_recommendations.ordem smallint NULL`

Rank **denso**, base 1, escopo `(farmer_id, customer_user_id, recommendation_type, run_id)`.

**Candidatos empatados no sinal recebem o MESMO valor.** Esta é a peça que impede a entrega de
trocar o endereço do bug: se empatados recebessem posições distintas, o vencedor passaria a ser
decidido pelo índice do array — a ordem de varredura do catálogo, que é `.order('id')`, que é uuid
**de novo**. Com rank denso, o empate vira **fato gravado** em vez de inferência de igualdade de
float na leitura.

Nulável porque as 1.083 linhas de 21/08 existem e não são recuperáveis (§3.5).

### 3.2 Quem calcula o rank (critério 2 — ordem justificável DENTRO de cada tipo)

- **`cross_sell`**: `pij` **não arredondado**, desc. O score já carrega `relevance`, que é termo do
  produto — a ordem é legítima; só não sobrevive ao `Math.round`. Empate genuíno (mesmo
  `buyerCount` e mesmo `assocBoost` ⇒ mesma `relevance`) permanece empatado e compartilha rank.
- **`up_sell`**: `compararCandidatosUpSell` (menor razão de preço → maior popularidade), sobre a
  referência **cronológica** que entrou na main em 07/09 (`preco-referencia.ts`). `upsell-ordem.ts`
  já tem o comparador **e** o predicado de empate (`candidatosEmpatam`, hoje privado) — o rank denso
  reusa os dois em vez de reimplementar a noção de empate.

**Nada disto toca `affinity_score` nem `p_ij`.** A "% de conversão" que a tela mostra continua
idêntica, e a armadilha que o #1837 nomeou (codificar ordem na magnitude é inventar score) fica
fechada: a ordem vai para uma coluna que É ordem.

### 3.3 RPC `farmer_melhores_individuais_por_cliente(uuid)` (nome novo — §3.4)

Devolve `jsonb` com até **dois** objetos por cliente. Contrato por objeto:

```
customer_user_id · recommendation_type · product_id · affinity_score · run_id · empatados
```

`empatados` = quantos candidatos **poderiam** ser o melhor daquele tipo:

- `ordem` conhecida em todo o grupo → quantos compartilham `min(ordem)`;
- **qualquer** `ordem` nula no grupo → **todos** os candidatos do grupo. Ordem desconhecida
  significa que nenhum candidato pode ser descartado — fail-closed, e é o que faz os registros
  legados se declararem sozinhos sem backfill.

`empatados = 1` é, por construção, "decidido por sinal". Um campo só, semântica exata, sem flag
redundante que possa divergir dele.

**Guard estrutural: `product_id` volta `NULL` sempre que `empatados > 1`.** Não existe "devolve o
vencedor e confia que o consumidor respeite a flag" — sem eleição por sinal, não sai nome. Torna
impossível renderizar a moeda por descuido, hoje ou num consumidor futuro (money-path §5: o guard
mora na fronteira que toda via cruza).

Preservados da RPC atual, e pelos mesmos motivos: `coalesce(…, '[]'::jsonb)` (`[]` = li e não há;
`NULL` = falhou, e o caller lança), `SECURITY INVOKER` (a policy `frec_select_carteira` segue sendo
a única fronteira), `REVOKE`/`GRANT` nomeando as roles.

### 3.4 Por que nome NOVO em vez de substituir

A RPC atual fica **intocada**. Isso elimina a janela de regressão entre os dois deploys manuais:
entre a migration e o Publish, o front velho chama a RPC velha e nada muda.

Se eu trocasse a assinatura da RPC existente, o front velho receberia **duas linhas por cliente** e
o `melhorIndividual.set(linha.customer_user_id, linha)` guardaria a última — arbitrário outra vez,
com o agravante de ser invisível. Também evita o `DROP`+`CREATE` que **reseta o ACL**
(`database.md` §4).

### 3.5 Registros existentes (critério 3) — sem backfill

Os 1.083 pendentes de 21/08 nascem com `ordem` nula e, por §3.3, reportam `empatados = N`: a tela
diz "N produtos igualmente indicados" em vez de eleger. **Isso já é o conserto**, e vale no dia da
migration, antes de qualquer recálculo — para de apresentar moeda como veredicto para os 235 pares
de hoje.

Backfill foi descartado com motivo: a ordem não é recuperável das colunas existentes (o #2350 já
mediu que `created_at` está empatado nos mesmos grupos), e re-derivar com preços de **hoje** sobre
uma geração de **21/08** fabricaria número — exatamente o que `precisão > recall` proíbe.

### 3.6 Leitor e tela (D4)

`ComparacaoIndividual` passa a ser por tipo. O cartão ganha duas células rotuladas — "Melhor
cross-sell" e "Melhor up-sell" — cada uma com quatro estados:

| estado | quando | o que mostra |
|---|---|---|
| `encontrado` | `empatados = 1` e o SKU resolve no catálogo ativo | nome do produto |
| `empatado` | `empatados > 1` | "N produtos igualmente indicados" |
| `nenhum` | a RPC respondeu e não há oferta daquele tipo | — |
| `indisponivel` | leitura falhou, ou o SKU eleito saiu do catálogo | rótulo + motivo |

`empatado` e `indisponivel` ficam **separados de propósito**: "li e empatei" não é "não consegui
ler". Colapsar os dois refaria, um nível abaixo, a fabricação de rótulo que o #1594 matou.

Efeito colateral desejado: o vendedor passa a ver a **família** da oferta. Era justamente a
invisibilidade do tipo (o cartão mostrava só o nome) que tornava a limitação indetectável para quem
avalia o bundle — o "custo aceito" que o #2350 registrou deixa de ser aceito.

### 3.7 Ordem em memória do cross-sell (D3)

`crossSellRecs.sort((a,b) => b.affinityScore - a.affinityScore)` ordena pelo score **arredondado**;
`Array.prototype.sort` é estável, então entre empatados vence a ordem de inserção — a varredura do
catálogo, que vem de `fetchAllPages` com `.order('id')`. O top-3 do vendedor é uuid pelo mesmo
mecanismo da RPC.

Como o motor já vai calcular o rank denso para gravar, o `sort` passa a usar a mesma chave. Fechar
só o lado persistido deixaria o mesmo defeito vivo com outra roupa.

## 4. Sequência de implantação (critério 3)

1. **Banco** — você cola no SQL Editor (`lovable-db-operator`):
   `ALTER TABLE … ADD COLUMN ordem` · `CREATE OR REPLACE` de `farmer_recomendacoes_substituir`
   (aceita e **valida** `ordem`: nula, ou inteiro ≥ 1) · `CREATE` da RPC nova.
2. **Publish** — motores gravam `ordem`; leitor chama a RPC nova; cartão com duas células.
3. **Recálculo** (um clique). Sem ele a tela diz "empatou" para os 238 clientes — honesto, mas é
   janela: fazer no mesmo dia.
4. **PR de limpeza** derruba a RPC antiga.

A ordem 1→2 é obrigatória, não preferencial: o escritor novo grava `ordem`, e contra o schema velho
o `jsonb_to_recordset` ignoraria a chave em silêncio — a coluna não existiria e **nenhum** rank
seria persistido, sem erro nenhum. O `CREATE OR REPLACE` do writer é pré-flightado contra
`pg_get_functiondef` da PROD (`database.md` §4: apply manual diverge do repo).

## 5. Prova (money-path: plpgsql é late-bound)

Harness PG17 estendendo `db/test-farmer-geracao-vigente.sh` (hoje 31 asserts + 4 falsificações):

- **positivos**: rank denso grava empatados com o mesmo valor; `empatados` conta o topo;
  `product_id` é `NULL` sob empate; grupo com `ordem` nula reporta `empatados = N`; `[]` na
  carteira vazia; dois objetos por cliente quando há os dois tipos.
- **negativos**: `ordem = 0` e `ordem` negativa recusadas com a SQLSTATE nomeada, re-lançando o
  resto (`WHEN OTHERS THEN 'OK'` é teatro).
- **RLS**: `SET ROLE authenticated` + GUC; carteira alheia não volta.
- **falsificação**: sabotar uma camada por vez, com **linha de base verde na MESMA invocação**, e
  conferir **contagem e NOMES** dos vermelhos — exit≠0 não distingue "pegou o bug" de "não rodou".

⚠️ **Armadilha herdada, e ela é específica desta entrega**: o doc de 07/09
(`preco-de-referencia-escolhido-por-uuid.md`) registra que o Codex removeu a referência da chave de
ordenação do up-sell e **12 testes seguiram verdes**, porque a fixture tinha **uma** base comprada —
com uma base só, `premium/ref` ordena igual a `premium`. As fixtures de up-sell aqui terão
**múltiplas bases com preços diferentes**, e haverá uma sabotagem dedicada a provar que essa
propriedade é medida.

## 6. O que esta entrega NÃO fecha (declarado)

- **A precedência entre tipos continua sem regra comercial.** D1 dissolve a comparação; não a
  resolve. No dia em que houver regra (margem, mix, prazo), ela entra como política explícita — e
  aí `empatados` já dá a base para dizer quando ela é aplicável.
- **`p_ij` é 0 em 645 de 714 linhas cross-sell** (`Math.round(0,0002 × 1000)/10 = 0`): o vendedor lê
  "0,0%" como probabilidade de conversão. Mesmo mecanismo de quantização, outra coluna, outro
  consumidor. Fica como achado registrado, com medição própria pendente.
- **Moeda comum em R$** (§1.3): sem substrato hoje.
