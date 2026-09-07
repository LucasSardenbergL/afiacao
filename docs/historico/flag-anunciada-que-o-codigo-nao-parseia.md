# A flag que o cabeçalho promete e o código não tem — `--falsificar` inerte sai VERDE

**2026-09-07.** O `scripts/test-onde-parei.sh` anunciava no próprio cabeçalho:

```
# Uso: bash scripts/test-onde-parei.sh              (exit 0 = tudo verde)
#      bash scripts/test-onde-parei.sh --falsificar (sabota a correção; exige vermelho)
```

**Não havia uma linha de código lendo `$1`.** A palavra `falsificar` aparecia no arquivo inteiro
exatamente uma vez: na linha 19, dentro daquele comentário. Shell ignora argumento desconhecido em
silêncio, então a flag caía na suíte normal e saía **exit 0**, com a saída **byte-a-byte idêntica**
à da execução sem flag (medido: `diff` vazio).

Isso é pior do que não ter o modo. Um arquivo sem `--falsificar` não promete nada; este promete
**vermelho** e entrega **verde**. Quem seguisse o "Uso:" — eu, numa sessão futura, ou o founder —
receberia ✅ e anotaria "falsificação feita". Veredito fabricado a partir de código que não existe:
a família de `ausente ≠ zero`, agora no eixo do *contrato declarado*.

## O corolário já estava escrito. Faltava ser gate.

[`falsificacao-fora-do-ci.md`](falsificacao-fora-do-ci.md) (**2026-08-24**) fechou com:

> `grep -l falsificar` casa quem tem o modo, quem falsifica inline e quem só menciona a palavra num
> comentário. O detector honesto é a **guarda de flag**, não a palavra. *Corolário para a próxima
> varredura: procurar a palavra mede vocabulário, não comportamento.*

O `test-onde-parei.sh` nasceu em **2026-09-05** (#2182), **12 dias depois**, com exatamente o defeito
que o corolário descreve. A lição não falhou por estar errada — falhou por ser **prosa**. Prosa não
roda no CI. Um corolário que descreve um detector e não o instala é uma nota, não uma guarda.

## São DOIS eixos, e o segundo é o que esconde o primeiro

Implementar a flag não basta: o `test:falsificacao` (`package.json`, rodado em `ci.yml`) é uma lista
**opt-in**, e `onde-parei` estava **fora dela**. Uma flag implementada que o CI nunca executa é
inerte do mesmo jeito — e é o estado mais difícil de notar, porque o código *parece* certo na
leitura. Foi por isso que o defeito durou: ninguém nunca rodou a flag, logo ninguém viu que ela não
fazia nada. (Mesma classe de [`gate-de-universo-opt-in.md`](gate-de-universo-opt-in.md).)

## O gate

`scripts/test-falsificar-implementado.sh` (no `test:hooks` **e** no `test:falsificacao`) cobra os dois:

1. quem **anuncia** `--falsificar` tem de ter ≥1 linha não-comentário citando a flag **e** lendo `$1`;
2. quem **parseia** tem de estar na lista do `test:falsificacao`.

O eixo (2) lê o `package.json` de propósito — uma fonte **por fora** do material varrido. Gate que só
se pergunta sobre os arquivos que ele mesmo lê herda o ponto cego desses arquivos.

O critério de (1) foi **medido**, não suposto: aplicado aos 5 arquivos que já implementavam, todos os
5 passam; aplicado ao `test-onde-parei.sh` de antes, dá 0. A própria falsificação do gate usa
fixtures (não `sed`): uma sã+registrada que ele **não** pode acusar, uma que anuncia sem parsear, uma
que parseia fora da lista, e um `package.json` sem a lista — porque não conseguir ler o denominador
é **ausência de dado**, não aprovação.

**Limitação conhecida:** uma suíte que falsifique *inline* e ainda assim escreva `--falsificar` num
comentário seria cobrada indevidamente. Nenhuma existe hoje (os 3 arneses inline citados no doc de
2026-08-24 não usam a grafia com os dois traços), e a mensagem do gate oferece a saída correta:
implemente o bloco **ou tire a linha do "Uso:"**.

## O que a mutação achou depois de instalada

Com o `--falsificar` finalmente real, 7 sabotagens da sonda, uma camada por vez, sobre uma **cópia**
servida por `SONDA_OVERRIDE` (o arquivo versionado nunca é tocado, então não há `restaurar()` capaz
de comer trabalho não commitado). Resultado: **6 mortas, 1 sobrevivente** —

> `[ -z "$ATUAL" ]` → `true` (desconto heurístico ignora a var estar definida) **passou verde**.

Nenhum dos 9 casos rodava **de dentro do próprio worktree com `CLAUDE_CODE_SESSION_ID` definido** —
que é o caminho **mais comum de todos**, o `bash scripts/onde-parei.sh` sem argumento. Ali a sessão
atual já sai da conta pelo `continue`; descontar de novo subtrai **duas vezes** e, com `n=1`, zera:
a sonda diria `3 = NADA A RETOMAR` com uma transcrição inteira em disco. É o fail-open que ela
existe para evitar, no caminho quente. Triagem: *comum-não-coberto* → fechado pelo caso 10.

O caso 8 não servia (a var é vazia ali de propósito) e o caso 2 também não (roda de fora, onde
`MESMO_WT=0` barra o desconto antes do guard). Aliás o caso 2 carregava uma terceira asserção
**vacuamente verde** — `nao_contem "só a atual"`, string que a sonda não emite em lugar nenhum, logo
nenhuma mutação poderia deixá-la vermelha. Removida em vez de trocada: era redundante com
`contem "1 sess"` (rotular a sessão alheia como atual daria 0). Trocar uma asserção morta por outra
asserção morta é teatro reverso.
