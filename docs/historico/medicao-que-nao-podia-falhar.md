# A medição que não podia falhar — dois jeitos de uma asserção existir sem poder reprovar

**2026-09-09.** Duas descobertas do mesmo dia, na mesma família da sonda/canária. Em ambas havia
uma asserção escrita, rodando no CI, verde — e incapaz de ficar vermelha pelo defeito que ela
nomeava. Não é falta de teste: é teste que não mede.

## 1. Os dois lados da comparação passavam pelo mesmo caminho

`scripts/sonda-versao-sql.test.ts` afirmava "contra o repo REAL: o marcador é o que o `index.ts`
emite". No ramo do marcador servido por `contrato`, ela comparava
`resolverCanarias(RAIZ_REPO, …, lerCanariasReal)` com `lerCanariasReal(RAIZ_REPO, …)`. Os dois
lados atravessam o MESMO leitor. Um leitor que devolvesse o marcador errado — de outra canária, ou
deformado — satisfaz os dois lados ao mesmo tempo, e a asserção não tem como notar.

Isso importa porque marcador errado no SQL faz a canária no ar responder outro contrato: o veredito
sai `CANARIA DE OUTRA FATIA`, e isso se lê como deploy pendente — a classe do incidente de
2026-09-05 que o guard de sincronia existe para fechar.

MEDIDO, com o leitor sabotado para devolver um marcador fixo: **sem** a âncora independente a suíte
saiu `rc=0`; **com** ela, `rc=1`; controle verde na mesma invocação. O ramo servido por REFERÊNCIA
já tinha âncora — lia o `versao.ts` cru — e por isso não sofria do mesmo mal. O conserto é ler o
`index.ts` cru e exigir o marcador como literal de `contrato`, por regex própria do teste. Regex
local aqui é o ponto, não o vício: é justamente o caminho do código que ela existe para não usar.

> Sensor que consulta a máquina que vigia herda o defeito dela — a regra já estava em
> [gates-textuais-cegos.md](gates-textuais-cegos.md). O que faltava era notar que uma comparação
> `f(x)` contra `f(x)` é essa mesma máquina duas vezes, mesmo quando os dois lados PARECEM
> diferentes por virem de funções com nomes distintos.

Falsificação no CI: `scripts/mutcheck.d/canaria-leitor-do-marcador.mut`.

## 2. Um byte fazia o arquivo sumir do alcance das ferramentas

`scripts/canaria-contrato-bump-gate.ts` — o gate que vigia o bump do `contrato` da canária —
guardava um sentinela `\0head`, escolhido para não colidir com rev git nenhuma. Só que o que estava
gravado no arquivo era o **byte 0x00 cru** dentro do literal, e não a sequência de escape de dois
caracteres. O código funcionava: `charCodes` do valor é `0,104,101,97,100` nas duas formas.

O efeito não estava no runtime, estava nas ferramentas. `file` classificava o arquivo como
`binary data`; `grep` só encontrava com `-a`; `diff` respondia **"Binary files differ"** — ou seja,
revisão de diff naquele arquivo era cega; e o `mutcheck`, que valida uma mutação contando as linhas
alteradas, media sempre **0 linhas**. Consequência: **nenhum `.mut` podia cobrir esse arquivo**, e a
recusa saía como `⚠ INVÁLIDO (tocou 0 linhas — regex largo)` — uma mensagem que acusa a regex de
quem escreveu, e não o encoding do alvo.

O que denunciou não foi a mensagem, foi a contradição: rodado à mão, o `perl` da mutação saía
`rc=0` e a string mutada ESTAVA no arquivo, enquanto o `diff` insistia em 0 linhas diferentes. As
duas coisas não podem ser verdade num arquivo de texto.

> Uma ferramenta de texto que encontra um byte de controle não erra: ela troca de modo, em silêncio,
> e passa a responder sobre outra coisa. Quando um guard reclamar de algo que você acabou de ver
> funcionar, desconfie do TIPO do arquivo antes de desconfiar da sua expressão.

Conserto: o escape de dois caracteres no lugar do byte cru — valor idêntico, arquivo de volta a
`text executable, Unicode`, os 49 testes do gate passando, e o `.mut` que antes era impossível
saindo `2 mutações · 2 pegas · 0 inválidas`.

**Ver também:** [gates-textuais-cegos.md](gates-textuais-cegos.md) (verde por cegueira do medidor),
[falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (controle verde na mesma
invocação), [prova-que-parou-de-ver-o-gerador.md](prova-que-parou-de-ver-o-gerador.md) (a prova
julgando um artefato que o PR não pode fazer reprovar).
