# O Apriori do farmer e o DENOMINADOR — duas fatias (2026-08-20/21)

> Lição durável: **corrigir uma leitura que estava errada pode QUEBRAR o consumidor que vivia do erro** — e o que separa "a correção falhou" de "a correção expôs o defeito seguinte" é a **cobertura com denominador**, não a contagem.

## O caso, em uma frase

`computeAssociationRules()` lia 479 dos 30.259 pedidos por causa do cap silencioso de 1.000 do PostgREST. Corrigir a leitura (Fatia 1, #1840) multiplicou o denominador por 63 — e como `support` é **razão**, o mesmo piso `s_min = 0.01` passou a exigir ~303 coocorrências. Das 24 regras publicadas sobrariam **2**.

## Fatia 1 (#1840) — a leitura

Quatro defeitos empilhados numa leitura só: sem paginação (cap de 1.000), sem `.order()` (fatia nem estável nem aleatória), sem filtro de status (cancelado entrava na cesta) e `error` descartado (falha de leitura virava "0 regras" com cara de sucesso). Mais o fence de escritor único no banco (`20260820225840`): a tabela é global e tinha **dois** escritores com universos diferentes — o cron e o browser —, e o último a escrever vencia.

A prova de que o universo de produção era a fatia não foi inferência: uma réplica SQL do algoritmo rodada sobre `LIMIT 1000` reproduziu as 24 regras **exatamente**, mesmos pares e mesmo lift até 6 casas. E o `sample_size` das 24 era 479 em todas.

## Fatia 2 (esta) — o denominador

### O que a contagem dizia e o que a cobertura mostrou

O primeiro relato da Fatia 1 dizia "queda de 92% de cobertura". Estava **errado**: 92% era a queda no **número de regras** (24 → 2). Número de regras não tem denominador, e por isso não é cobertura de nada. Medido de verdade, com denominador, via `psql-ro` (2026-08-21):

| Consumidor (denominador) | A: prod hoje | B: Fatia 1 só | C: segmentado |
|---|---|---|---|
| MixGap (525 clientes de carteira elegível/12m) | 116 (22,1%) | **0 (0,0%)** | 84 (16,0%) |
| `recommend` + cross-sell (1.208 clientes com histórico) | 266 (22,0%) | 250 (20,7%) | **351 (29,1%)** |
| Melhorias (3.143 SKUs ativos que são antecedente) | 14 | **0** | 8 |

A leitura correta é mais dura que "queda de 92%" **e** mais dura que "queda de 266 para 250": a Fatia 1 sozinha **zera** dois dos três consumidores. O MixGap cai a 0 porque ele filtra por carteira elegível e janela de 12 meses — as 2 regras globais alcançam 250 clientes no histórico completo e **nenhum** na carteira ativa.

⚠️ **A ausência de linha num `GROUP BY` não é o zero.** O cenário B simplesmente não apareceu no primeiro resultado; foi preciso refazer a query com `LEFT JOIN` sobre a lista de cenários para que o `0` fosse **medido** em vez de inferido do silêncio.

### A correção: o denominador, não o piso

Baixar `s_min` até a contagem voltar a agradar é **recalibrar pela contagem desejada** — o critério deixa de significar qualquer coisa. A correção é segmentar por `sales_orders.account`. Com o **mesmo** `s_min = 0.01` e o **mesmo** `l_min = 1.2`:

```
GLOBAL (as duas contas misturadas, 30.257 cestas) →  2 regras
colacor                        (19.030 cestas)    →  2 regras
oben                           (11.227 cestas)    → 12 regras
                                                    ── 14 no total, 7× o global
```

O denominador global **afoga o sinal da conta menor**: um par presente em 1,1% dos pedidos de oben é 0,4% do grupo, e some sob o piso.

### Por que `account` é o eixo natural (e não a partição que dava o número que eu queria)

A pergunta certa é "que evidência falsificaria isto?", e ela foi medida:

- Dos **3.287** produtos que aparecem em pedidos, **100% aparecem em exatamente uma conta**. Zero cross-account.
- **0** regras têm antecedente numa conta e consequente na outra — nem no cenário segmentado, nem nas 24 vigentes.
- Uma cesta é um pedido, e um pedido tem uma conta só: a coocorrência é intra-conta **por construção**.

### O que NÃO é verdade: "cliente pertence a uma conta"

Medido: 588 clientes compram só em colacor, 146 só em oben, e **493 compram nas duas** — 24.738 de 30.979 pedidos, **80% do volume**. Cliente **não** tem conta única.

O que salva o serving é que os quatro consumidores casam por **PRODUTO**, não por identidade de cliente:

| Consumidor | Como casa | Piso |
|---|---|---|
| `get_meu_mixgap` → `_carteira_mixgap_for_owner` | `antecedent_product_ids <@ produtos que o cliente comprou` | `confidence≥0.15 AND lift≥1.5 AND sample_size≥30` |
| `melhoria_produtos_relacionados` | produto-alvo da busca ∈ `antecedent_product_ids` | nenhum; `order by max(lift) limit 10` |
| edge `recommend` | `antecedent.every(id => cesta.has(id) \|\| comprados.has(id))` | `.gte("lift",1.2).gte("support",0.01)` hardcoded |
| `useCrossSellEngine` | idem, via histórico | `.gte('confidence',0.05).gte('lift',1.0)` |

Com catálogos disjuntos, regra de oben **não alcança** cliente colacor-puro: o isolamento é estrutural. Por isso **nenhum consumidor ganhou filtro por `cluster_segment`** — a coluna é **proveniência do denominador**, não predicado de serving. Para os 128 clientes multi-conta que recebem regras dos dois segmentos, receber as duas é **correto**: eles compram nas duas.

⚠️ **Mas o isolamento é fato do DADO, não do desenho** (achado do challenge Codex xhigh). A UNIQUE de `omie_products` é `(omie_codigo_produto, account)` — o mesmo código **pode** existir nas duas contas. E `_carteira_mixgap_for_owner` casa por `oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto`, **sem qualificar a conta**, sobre 1.839 linhas de `order_items`. Medido: **0** códigos em mais de uma conta hoje. Como 0 hoje não é 0 amanhã, virou **sensor medido a cada execução** (`omie_products_codigos_multi_conta()`), não suposição — mesma forma dos guards de status nulo e conta nula.

## A armadilha do LOTE ÚNICO: perda parcial de segmento

A substituição continua sendo **um lote com os dois segmentos**, DELETE-tudo + INSERT-tudo numa transação (`DELETE WHERE cluster_segment = …` por segmento quebraria a atomicidade do #1840 e criaria "colacor novo + oben velho" sem nada que denuncie).

O buraco que isso abre — e que o `TR001` **não** cobre: um lote com 12 regras de oben e **zero** de colacor não está vazio. Passa em tudo e **apaga colacor**. Nada erra, nada alerta.

Duas defesas, em lados diferentes, e nenhuma cobre a outra:

- **No produtor:** aborta se um segmento processado não produziu regra nenhuma (só o produtor sabe quais segmentos **rodaram** — num array de regras, "processado com zero" é indistinguível de "esquecido por bug").
- **Na RPC (`TR007`):** recusa o lote que **perde um segmento já publicado**. É o que a RPC consegue saber sozinha.

## O que ficou de fora, e por quê

Achados do Codex que são **preexistentes** aos dois PRs e não entraram nesta fatia:

1. `recommend` monta `purchasedProductIds` direto de `order_items`, **sem** o pai `sales_orders` — pedido cancelado/soft-deletado ativa antecedente. O produtor já filtra; o consumidor não.
2. `melhoria_produtos_relacionados` deixa o alvo casar até 5 SKUs de contas diferentes e não devolve `account` em `comprados_juntos`.
3. MixGap e Melhorias fazem `max(confidence)` e `max(lift)` **separadamente** e multiplicam os máximos — que podem vir de **regras diferentes**. É uma tupla estatística fabricada, e fica mais alcançável com mais regras.
4. `carteira.mixgap_visto` só dispara com `totalComGap > 0`: "abriu e recebeu zero" segue indistinguível de "nunca abriu" — o `Number(null)===0` da adoção, na própria tela que esta fatia serve.
5. `fetchAll` não é snapshot: as ~69 páginas são ~69 instantes (§14 do money-path). Os guards de status/conta rodam num instante ainda anterior.
6. `.gte("support", 0.01)` no `recommend` é **tautológico** enquanto o produtor usar `s_min = 0.01` — e vira um segundo piso oculto se a config baixar. Falta escolher uma autoridade.

## Sobre normalizar o `support` (decidido: NÃO nesta fatia)

Com a segmentação, o `support` de oben passa a ser ~2,7× maior (denominador 11.227 em vez de 30.257) e o de colacor ~1,6×. No `recommend` o score é `log(max(lift,1)) × confidence × support`, então para os **128** clientes multi-conta o ranking compara razões de denominadores diferentes.

O Codex (xhigh) argumentou que isso **não** é automaticamente "maçãs com laranjas": `support_s` responde uma pergunta válida ("que fração dos pedidos desta conta contém o par?"), e o lift "global" de 2,42–143 está **inflado** por pedidos da outra conta onde o consequente não poderia aparecer — zeros estruturais no denominador. Uma conta menor não é favorecida por ser menor; é favorecida se o par for proporcionalmente mais frequente naquele mercado.

Se um dia a decisão de produto for "rankear por prevalência no volume do grupo", existe a normalização principiada — e ela é **outra função-objetivo**, não uma correção matemática:

```
support_grupo = support_segmento × sample_size_segmento / Σ sample_size_segmento
score         = log(lift_segmento) × confidence_segmento × support_grupo
```

O risco mais concreto não é o tamanho da conta: é a **ativação binária**. Um cliente com 99% das compras em colacor e **uma** compra em oben habilita os dois segmentos igualmente. Corrigir isso exige contexto da cesta ou intensidade/recência por conta — mudança de modelo, não de piso.

## O sensor (para a fase seguinte não nascer sem sinal)

`cluster_segment` estava **NULL em 100%** das 24 linhas e nenhum consumidor o lia. Escrevê-lo sem nada com que confrontá-lo seria evidência inerte — a regra de `fase-sem-sinal.md`. O par mínimo:

- **Na tabela:** `cluster_segment` + `sample_size` do universo daquele segmento.
- **No registro de execução:** `por_segmento` (cestas, regras, itens frequentes, truncadas), `segmentos`, `itens_descartados`, `params`. Sem isso a proveniência morre no mapper de `acoes_execucoes` — que é onde ela **já tinha morrido uma vez**, na fatia anterior, pelo mesmo caminho.

A query de decisão responde **por geração**: segmentos 2/2, denominador por segmento, clientes elegíveis / alcançados / overlap. "14 regras" é observação, não contrato.

## A primeira leitura de produção (2026-08-22)

O desenho acima foi verificado **em produção**, não só em PG17. Vale registrar duas coisas: os números, e o intervalo em que eles não existiam.

**A migration mergeou às 00:45 UTC e não estava aplicada às 01:29 UTC** — `merge na main ≠ produção`, a falha silenciosa de sempre. Quem a pegou não foi ninguém olhando para esta entrega: foi o **audit de migrations do #1854**, que confere o que terceiros mergearam na janela. As três sondas liam `AUSENTE / AUSENTE / NÃO` (constraint, sensor, `TR006` no corpo). Sem esse audit, o cron das 07:30 UTC teria rodado com a edge nova contra a RPC velha — e o `jsonb_to_recordset` **descartaria `cluster_segment` em silêncio**, publicando 14 regras sem proveniência. Verde na tela, errado na tabela. A ordem `migration → edge` não é preferência: é a única direção cujo modo de falha é alto.

Aplicada e recomputada, `net._http_response` (id 57611, **HTTP 200**, 02:21:45 UTC):

| | cestas | regras | truncadas |
|---|---|---|---|
| colacor | 19.030 | 2 | 0 |
| oben | 11.227 | 12 | 0 |
| **total** | **30.257** | **14** | **0** |

`itens_descartados: 0`, `segmentos: 2`, `params` `s_min=0.01 / l_min=1.2 / max_rules_por_segmento=500`. As cestas somam exatamente o universo da Fatia 1 (19.030 + 11.227 = 30.257), e os pares 2/12 são os previstos aqui — mesmos pisos, denominador por conta. Na tabela: 14 linhas, `cluster_segment` NULL em **0**, `sample_size` = 19.030 para colacor e 11.227 para oben. `lift` de 5,39 a 53,21 em oben; 5,41 em colacor.

Três invariantes que a escrita **não** quebrou, medidas depois dela: o ACL da RPC seguiu `postgres | service_role | sandbox_exec_…` — o fence de escritor único do #1840 sobrevive ao `CREATE OR REPLACE`, como o cabeçalho da migration argumentava; o sensor `omie_products_codigos_multi_conta()` leu **0**, então o isolamento entre contas continua sendo fato medido e não suposição; e o `CHECK`, que nasceu `NOT VALID` para poupar as 24 linhas legadas, foi validado depois que o recompute as substituiu — `pg_get_constraintdef` já não traz o sufixo.

**O que esta leitura ainda NÃO diz.** Ela confirma a *produção* das regras, não o *efeito* delas. A tabela A/B/C acima projeta cobertura — MixGap 84 (16,0%), recommend+cross-sell 351 (29,1%), melhoria 8 — e nada disso foi medido em prod ainda: são números do consumidor, a jusante. Contar 14 regras e concluir "funcionou" seria trocar o eixo da decisão pelo que é fácil de contar, que é o defeito que esta fatia inteira corrige. O próximo sinal é a cobertura por geração, com denominador — e ele vem do `farmer_recommendation_desfecho` (#1851, já aplicado), não daqui.

## Provas

- `supabase/functions/_shared/apriori_test.ts` — 8 testes Deno do helper puro. O universo de brinquedo (100 cestas numa conta, 20 na outra) reproduz o fenômeno em aritmética verificável à mão: mesmo piso, global = 0 regras, segmentado = 2.
- `db/test-assoc-rules-segmento.sh` — 31 asserts PG17 + 4 falsificações com dente. Aplica a **cascata completa** das 4 migrations (o harness irmão aplica só a de 2026-07-29 e prova a versão **daquela fase**, não a de produção — #1515).

⚠️ **Dois vermelhos de encanamento que se leem como vermelho de asserção**, mordidos nesta entrega:
- O seed das linhas legadas rodava **depois** do `CHECK`, batia em `check_violation` e abortava o harness em `set -e` com **exit 3 e zero assert rodado**. Semear antes da migration não é estética: é o que reproduz a prod, onde as 24 linhas já existem quando o founder cola o SQL.
- `P -tA <<SQL … SQL 2>&1` põe o `2>&1` **depois** do terminador do heredoc, onde ele vira comando solto: o stderr escapa da captura e as sentinelas — que são `NOTICE`, portanto stderr — somem. Seis asserts negativos reprovaram com `erro inesperado: DO`, o eco do bloco que rodara certinho.
