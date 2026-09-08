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

`@suspeito` **nunca poda a medição**. Ele existe para o relatório confrontar *declarado × medido*,
e o achado mais útil da ferramenta é exatamente "o autor achava que só o dele pegava; a medição
mostrou outros três".

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
