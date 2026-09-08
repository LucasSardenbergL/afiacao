# O custo de um gate é medido para sempre; o benefício não era medido em lugar nenhum

**Data:** 2026-09-07 · **Substrato:** os 28 gates bloqueantes do `ci.yml` · **Origem:** parecer Codex (gpt-6-astra, reasoning max)

## O desequilíbrio

Todo gate do CI tem duas grandezas. Uma é **medida e visível para sempre**: os segundos que ele
consome no log, a cada PR, para o resto da vida do repositório. A outra — quais defeitos ele pega
que ninguém mais pega — **não era medida em lugar nenhum**.

Com um lado da conta visível e o outro invisível, "criar mais um gate" é sempre a escolha barata.
E o número mostra isso: **15 dos comandos-gate do `ci.yml` entraram em 3 semanas**, e o job
`gates-e-falsificacao` cresceu **4,4× em 11 dias** (Falsificação: 46s → 201s), virando o gargalo do
CI com mediana de 357s. Cada gate nasceu de uma lição real e cada um é defensável isoladamente. O
que faltava não era disciplina — era **denominador**.

## A armadilha que quase virou o diagnóstico

O levantamento inicial observou que, numa janela de 80 runs, **apenas 5 gates reprovaram algo**
(Tests, Type check, knip, `claude:size`, `authz:carimbo`). A conclusão tentadora — "os outros 23
não pegam nada" — está errada, e o parecer do Codex foi explícito:

> "Não tenho evidência para afirmar 'nunca pegou nada'."

`docs:links` registra **dez links quebrados** encontrados no próprio histórico e mesmo assim não
apareceu na janela. Oitenta runs não medem um evento raro. **Ausência de sinal não é veredito** —
é a armadilha nº 1 deste repositório, e ela quase foi cometida pela ferramenta criada para evitá-la.

Por isso a grandeza medida aqui nunca é "o gate é inútil". É:

```
gatesQueReprovaram(d) = { g : g fica vermelho com o defeito d aplicado }
exclusivoDe(g)        = { d : gatesQueReprovaram(d) == {g} }
```

E `exclusivoDe(g)` vazio significa **apenas**: *neste corpus de N defeitos, tudo que `g` pega,
outro também pega.* O denominador anda grudado no número em toda saída da ferramenta.

## Como se mede

`bun run exclusividade:medir` aplica **um defeito por vez ao repositório real** e registra quais
gates ficam vermelhos. A disciplina é herdada do `mutcheck.sh`, onde já havia sido pensada:

| guard | o que ele impede |
|---|---|
| árvore limpa + **baseline verde** | sempre-vermelha aprova tudo (`falsificacao-sem-linha-de-base.md`) |
| cópia + trap em SIGINT/SIGTERM | o repo nunca fica mutado, nem em Ctrl-C |
| anti-não-aplicação | regex que envelheceu = INVÁLIDO, jamais um falso "ninguém pegou" |
| perturbação mínima (teto 2) | sabotagem larga demais mede um estrago que ninguém commitaria |
| **poda por custo, não por declaração** | gates rodam do mais barato ao mais caro e param no 2º vermelho |

A última merece ênfase. O corpus deixa o autor declarar `@suspeito` — quem ele *acha* que pega —
mas isso **nunca poda a medição**: todo gate roda contra todo defeito. Deixar a declaração podar
seria podar a favor de quem declara. `@suspeito` só decide como o resultado é **rotulado**.

## Os defeitos que a própria ferramenta cometeu

Três, e os três são da mesma família — fabricar veredito a partir de dado ausente:

1. **Zero que media o corpus, não o gate.** Na primeira medição real o `test` (vitest) saiu com
   exclusividade zero e foi rotulado "redundante". A verdade é que nenhum dos 6 defeitos era de
   código de aplicação: o zero media o corpus. Hoje `corpusMirou` separa `[redund]` (o corpus
   mirou nele e ainda assim foi co-pegado) de `[s/ mira]` (ninguém escreveu um defeito para ele).
2. **Medição parcial apagando medição anterior.** Uma rodada com `--gates docs:*` substituiu a
   linha inteira de um defeito e apagou a execução do `test` medida antes — e `docs:indice`, que a
   medição com o vitest mostrara co-pegado, reapareceu como `[SO ELE]`. **Exclusividade fabricada
   a partir de dado que existia e foi descartado.** A fusão passou a ser por `(defeito, gate)`.
3. **Gate sumindo do relatório.** Um gate cujas únicas linhas foram invalidadas não aparecia na
   derivação — a pior forma de exclusividade zero é a que nem se sabe que existe.

## O que a primeira leva mediu

Sete defeitos, oito gates. Duração é a **mediana local**, não do runner — serve para ordenar, não
para prever o CI (`medir-ganho-de-ci-sob-ruido.md`: o runner varia 45%).

| gate | exclusivos | pegou | mediana | leitura |
|---|---|---|---|---|
| `bunpin:check` | **1**/7 | 1 | 57ms | só ele pega o bun despinado |
| `claude:size` | **1**/7 | 1 | 81ms | só ele pega a linha de manual gigante |
| `docs:links` | **1**/7 | 2 | 903ms | só ele pega link quebrado FORA de índice |
| `exclusividade` | **1**/7 | 1 | 245ms | só ele lê a matriz — nenhum outro gate a enxerga |
| `gates:frescura` | **1**/7 | 1 | 419ms | só ele pega gate que sumiu do censo |
| `docs:indice` | **0**/7 | 2 | 58ms | zero **por CÓPIA**, e a cópia só saiu pela metade — ver abaixo |
| `test` (vitest) | 0/7 | 2 | 128s | `[s/ mira]`: nenhum defeito foi escrito para ele |
| `docs:citacoes` | 0/7 | 0 | 3,8s | `[s/ mira]`: idem — e é o mais caro dos "baratos" |

### O achado central, e ele inverte a recomendação

O parecer do Codex apontou que `docs:indice` audita o repositório **dentro do vitest**
(`scripts/docs-indice-gate-check.test.ts:265`, bloco "o repo de verdade") **e de novo** num step
separado do CI. A medição confirma — mas o lado a cortar não é o que a leitura ingênua sugere:

| defeito | `docs:indice` | `docs:links` | `test` |
|---|---|---|---|
| `indice-orfao` (entrada some do índice) | 🔴 182ms | verde | 🔴 **128s** |
| `indice-alvo-fantasma` (entrada aponta p/ arquivo inexistente) | 🔴 39ms | 🔴 449ms | 🔴 111s |

Os dois são redundantes **um com o outro**, e a exclusividade de ambos é zero *porque o outro
existe*. Cortar o step de 58ms economiza 58ms e piora o diagnóstico: ele diz exatamente o que
quebrou, na hora. Cortar a asserção do vitest tira a mesma detecção de dentro de um gate de 128s,
onde ela chega ao autor no meio de 800 arquivos.

**A recomendação é manter o step e retirar a duplicata do vitest** — o inverso do que "o step é
redundante" sugeriria.

#### O corte foi executado — e a duplicação NÃO saiu inteira

A asserção que auditava o repo de ponta a ponta dentro do vitest
(`auditarIndices(lerDiretoriosIndexados())`) saiu. Remedindo `indice-orfao` logo depois:

```
defeito indice-orfao
  VERMELHO docs:indice (363ms)
  VERMELHO test (687061ms)      <- continuou pegando
[redund]  docs:indice  exclusivos 0/8 - pegou 2
```

`docs:indice` segue com exclusivo ZERO. O corte acertou o alvo — o step continua vermelho, então
não foi ele que se perdeu —, mas a detecção do órfão **sobrevive noutro lugar do mesmo arquivo**:
a guarda anti-vácuo `cada índice real tem exatamente uma entrada por doc do diretório`. Sabotando
o repo e rodando só aquele arquivo (controle verde de 34 na mesma invocação), o vermelho é único e
tem nome:

```
× o repo de verdade > cada índice real tem exatamente uma entrada por doc do diretório
  Tests  1 failed | 33 passed (34)
```

As outras duas guardas do bloco ficaram VERDES sob o defeito — elas são cegas ao órfão, anti-vácuo
de verdade. A duplicação está inteira num `expect` só.

**A lição é sobre o formato da asserção, não sobre o gate.** A guarda declara, no próprio
comentário, proteger as invariantes 3/4/5 de um parse que devolvesse `[]`. Mas ela foi escrita como
IGUALDADE DE CONJUNTO entre as entradas do índice e os arquivos do diretório — e igualdade de
conjunto *é* a invariante do órfão. A implementação excede o contrato declarado, e o excedente é
exatamente a parte que duplica o step. Uma guarda fiel ao que ela diz proteger cobraria *volume* de
entradas ("o parse não morreu"), não *identidade* com a lista de arquivos.

Estreitá-la é decisão em aberto, e deliberadamente não tomada aqui: enfraquecer uma rede anti-vácuo
para ganhar 0 exclusivo é caro pelo lado errado. Fica medido para quem decidir.

#### Cuidado ao ler a coluna `mediana` desta remedição

O `test` acima aparece com 687s, contra os 128s da primeira medição — a mesma máquina sob swap
(~30 sessões vivas na M2 8GB), não uma regressão do gate. O baseline saltou de 215s para 468s no
mesmo intervalo. **O eixo VERDE/VERMELHO atravessou a carga sem se mexer; o eixo do TEMPO variou
5×** — bem além dos 45% de ruído de runner que `medir-ganho-de-ci-sob-ruido.md` registra. A matriz
guarda `medidoEm`/`sourceHead` GLOBAIS, mas a remedição é PARCIAL por desenho (`--defeitos`/
`--gates` reescrevem só as células pedidas): logo, medianas de células diferentes podem vir de
máquinas e cargas diferentes, e não são comparáveis entre si.

A sobreposição parcial com `docs:links` que o Codex também anotou está medida na segunda linha:
os dois pegam o alvo-fantasma, mas só `docs:links` pega o link quebrado fora de um índice. As
obrigações são **distintas** e as duas ficam.

### Sobre os dois `[s/ mira]`

`test` e `docs:citacoes` aparecem com zero exclusivos, e isso **não diz nada sobre eles**: nenhum
dos 7 defeitos foi escrito mirando neles. É ausência de dado com aparência de resultado — o rótulo
existe justamente para não deixar essa leitura acontecer. `docs:citacoes`, aliás, provou seu valor
fora da matriz durante este próprio trabalho: pegou uma citação `ci.yml:921` que ficou obsoleta
quando o novo step deslocou as linhas do arquivo.

## O sub-achado: o manual afirmava algo falso sobre a própria máquina

`docs/agent/deploy.md` anunciava **"Gates do CI — reprovam o PR (29)"** com `mutcheck` e
`mutcheck:selftest` na lista. Os dois são informativos **por desenho**: o job `mutation-check` está
fora de `validate.needs` e abre Issue em vez de barrar, desde o #2344.

A causa é fina: `inventarioCI` filtra `continue-on-error` no **step**, e não enxerga a outra forma
de ser informativo — o **job inteiro** ficar fora do `needs`. Quem separa agora é `jobsBloqueantes`,
pelo fecho transitivo do grafo: derivado, não uma lista de exceções que envelhece sozinha.

## O bootstrap tem um nó, e ele é honesto

Um gate novo reprova por falta de medição; a medição exige baseline verde; o baseline inclui o
gate novo. Circular. A saída é um **andaime declarado**: dispensa temporária, mede, retira a
dispensa — e o gate passa por mérito. Foi exatamente o que este gate fez consigo mesmo, depois de
ter entrado sozinho na própria lista de dispensados (um gate novo se auto-dispensando da regra que
existe para gates novos). A dispensa vive no artefato versionado: acrescentar um nome a ela aparece
no diff do PR, que é o ponto.

## A regra

**Um gate novo bloqueante precisa exibir ≥1 defeito em que ele é o ÚNICO vermelho.** É o que
`bun run exclusividade` cobra no CI, lendo a matriz — barato, sem executar gate nenhum.

O que ele **não** faz: reprovar por exclusividade zero. Corpus curto não mede gate raro; zero é
**relatado**, com o denominador, e o corte é decisão de quem tem a evidência na mão.
