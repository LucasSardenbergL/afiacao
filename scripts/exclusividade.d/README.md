# Corpus de defeitos — o denominador da contribuição exclusiva

Cada `.def` deste diretório descreve **defeitos aplicados ao repositório real**. O motor
(`bun run exclusividade:medir`) aplica um por vez e registra **quais gates ficam vermelhos** —
disso sai a única grandeza que faltava na decisão "criar mais um gate": quantos defeitos **só ele**
pega.

## Formato

```
# @origem:   de onde veio o defeito (doc do histórico, PR, ou o script cuja sabotagem foi traduzida)
# @suspeito: quem o AUTOR acha que pega
<id> | <alvo> | <expressão perl -pe>
```

Os dois comentários valem para todas as linhas seguintes, até serem redefinidos. Como no `.mut`, o
separador é `|` e **o 3º campo é o resto da linha** — a expressão perl legitimamente contém `|`
(alternation), e um split ingênuo truncaria a regex no meio.

`@suspeito` **nunca ordena nem poda a medição** — a poda é por custo e para no 2º vermelho. Ele
existe para o relatório confrontar *declarado × medido*, e o achado mais útil da ferramenta é
exatamente "o autor achava que só o dele pegava; a medição mostrou outros três". O que ele muda:
se a poda o deixou de fora, o motor o **executa depois, sozinho** — sem isso o suspeito saía
"medido" sem ter rodado. Tem de nomear um gate bloqueante do `ci.yml` (typo aborta o motor).

## O autor diligente: `@dever-de-casa`

```
# @dever-de-casa: bump-versao <edge>
# @dever-de-casa: regenerar-fingerprints
<id> | <alvo> | <expressão perl -pe>
```

Por padrão uma linha mede o autor **descuidado** — só o defeito. Para gate semântico sobre edge
instrumentada, isso mede zero sempre: os gates de BYTES (`sonda:bump`, `sonda:fingerprint`) pegam
qualquer mudança no `index.ts`. O autor que fez o dever de casa escapa deles, e sobra quem olha o
significado — é esse o cenário que o gate semântico existe para cobrir, e é nele que a medição
descobre se outro já o cobria (em `sonda-autentica.def`, um contrato Deno cobria). Meça os dois — em
linhas com ids diferentes.

- **Vale SÓ para a próxima linha de defeito**, ao contrário de `@origem`/`@suspeito`. De propósito:
  herdado por engano, ele calaria os gates de bytes num defeito que não o pediu — exclusividade
  inflada. Pendurado no fim do arquivo, o parser recusa.
- **Vocabulário fechado** (`RECEITAS` em `scripts/lib/exclusividade.ts`), nunca comando livre: um
  "pós-passo" de shell poderia apagar o script de um concorrente e sair 0. Critério de admissão de
  uma receita nova: **ela é o conserto que o próprio gate concorrente prescreve na mensagem de
  falha dele** — a suíte confere a citação literal na fonte do gate.
- **Efeito exato**: só as saídas declaradas mudam; o alvo segue byte-idêntico ao pós-sabotagem.
  Receita que não muda nada ou falha = linha INVÁLIDA; que escreve fora das saídas = motor aborta.
- **A ordem importa**: `bump-versao` antes de `regenerar-fingerprints` (o `versao.ts` está no fecho
  da edge; regenerar antes deixaria o mapa velho — e o `sonda:fingerprint` pegaria, o que só
  subestima).

## As três regras que um defeito precisa respeitar

1. **Alvo real, nunca raiz sintética.** As sabotagens `--falsificar` dos `test-*.sh` rodam contra
   um repo de mentira em `$TMP/raiz` — o que prova o poder daquele gate, mas não dá a *nenhum
   outro gate* a chance de ver o defeito. Aqui o alvo é um arquivo versionado de verdade.
2. **Plausível.** A sabotagem tem que produzir um estado que um humano commitaria por engano. Um
   arquivo com sintaxe destruída é pego pelo compilador e não mede gate nenhum — mede o `tsc`.
3. **Perturbação mínima** (o motor recusa mais que 2 linhas perturbadas). Se a expressão casa em
   vários lugares, prenda-a com um flag de estado: `$feito = 1 if !$feito && s/…/…/;` — sem isso o
   perl substitui as 6 ocorrências e a linha vira INVÁLIDA por regex largo.

## O que uma linha INVÁLIDA significa

Que a medição **não aconteceu** — jamais que "ninguém pegou". Um `.def` cuja regex envelheceu e
parou de casar é ausência de dado, e o motor a separa do resultado justamente para que ela não
seja lida como exclusividade zero. Corrija o `.def` e re-meça.

## Quando uma linha CERTIFICA `[SO ELE]`

Só quando rodou **todo** gate bloqueante do `ci.yml`, **com a invocação do CI** e sem poda, e teve
um único vermelho. Linha medida com `--gates` (subconjunto) e um único vermelho sai `[inconcl]`:
os gates ausentes são desconhecidos, não verdes. Execução gravada com outra invocação (ex.: o
`bun run tsc` no-op de antes da paridade) não conta como execução.
