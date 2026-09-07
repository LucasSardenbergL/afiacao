# A espera que sobreviveu ao que esperava (2026-09-07)

Três laços de espera meus giraram indefinidamente numa sessão, apareceram para o founder como
"3 tarefas em execução", e o que eles esperavam já tinha morrido havia mais de uma hora.

## O que aconteceu

Na sessão da fatia de gatilho (#2294), a fila do `heavy` estava com **1 slot e 14 jobs**. Para não
ficar bloqueado, armei o vitest em background e um laço para me avisar quando terminasse:

```bash
until grep -qE "Test Files|No test files|failed to load" "$SCR/red1.txt"; do sleep 20; done
```

Repeti o padrão três vezes, com marcadores ligeiramente diferentes, à medida que reenfileirava o
teste. Nenhum dos três terminou. Quando o founder perguntou "e essas 3 tarefas em execução?", os
três estavam vivos, em `sleep`, havia mais de uma hora.

A causa está no arquivo que eles liam. O `heavy` abortou o job pela fila e escreveu no `red1.txt`
o **seu** diagnóstico:

```
… pode ser a fila — confira `uptime` e órfãos (ps -Ao ppid,pid,time,command | awk '$1==1').
```

Isso não casa `Test Files`, não casa `No test files`, não casa `failed to load`. O vitest nunca
rodou, então o marcador de sucesso nunca apareceu — e o marcador de FRACASSO não estava na busca.
O laço não tinha como saber a diferença entre "ainda não terminou" e "não vai terminar nunca".

## A classe

**Espera é fail-OPEN por omissão.** `until <sucesso>; do sleep; done` só sabe reconhecer que deu
certo; todo o resto do universo — job abortado, arquivo sobrescrito, processo morto, comando que
nunca chegou a rodar — cai no mesmo ramo, que é *continuar esperando*. E esperar não emite sinal:
o silêncio de um laço saudável e o de um laço órfão são idênticos.

É a classe `ausente ≠ zero` deslocada para o eixo do **tempo**. Onde a UI fabricava "não há" a
partir de "não consegui ler", a espera fabrica **"ainda está em andamento"** a partir de "isto
nunca vai chegar". Nos dois casos a ausência de dado é lida como um estado benigno, e nos dois
casos o custo é o mesmo: quem observa conclui que está tudo caminhando.

Ironia registrada porque ela é o argumento: isso rodou na sessão inteira **enquanto eu corrigia
oito sítios da mesma classe na UI**. Reconhecer o padrão num lugar não o faz visível no outro — a
classe mora no raciocínio, não no arquivo.

## Por que ninguém pegou

Laço de espera não tem fiscal. O gate de auto-ocultação vigia JSX; o `psql:errorstop` vigia SQL em
script; o `pr-watch.sh` tem exit 5 (sem desfecho) separado do 6 (não consegui consultar) —
justamente esta distinção, e ela existe porque **alguém já pagou por confundir os dois**. O laço
`until` cru é o mesmo defeito sem a lição aplicada: ele só tem o 5, e usa o 5 para tudo.

O custo desta vez foi baixo (ruído, e um diagnóstico errado de meia dúzia de linhas). Não é
garantido: um laço que espera um deploy, uma migration ou um CI e nunca desiste devolve
"em andamento" para sempre — e "em andamento" é exatamente a resposta que impede alguém de ir
verificar.

## A regra

Todo laço de espera leva as duas coisas que faltaram:

1. **Teto** — `for i in $(seq 1 N)` em vez de `until` nu, com o ramo do estouro dizendo
   explicitamente *não consegui*, nunca terminando em silêncio nem em `exit 0`.
2. **Marcador que cobre a FALHA** — se a busca é `"Test Files"`, ela precisa ser
   `"Test Files|error|abort|timeout|exit"`. Perguntar antes de armar: *se isto morrer agora, meu
   filtro imprime alguma coisa?* Se a resposta é não, o filtro está estreito demais.

Complemento barato para espera por arquivo: **checar frescor, não só conteúdo**. Um `red1.txt` que
não muda há 10 minutos já responde "o produtor morreu" sem depender de adivinhar a string certa.

E a preferência de mecanismo, quando existir: para *uma* notificação, `Bash` com
`run_in_background` e um comando que **sai** quando a condição é verdadeira — o laço órfão vira
impossível porque o processo termina. `Monitor` é para stream de eventos, e a doc dele diz a mesma
coisa por outras palavras: *silêncio não é sucesso*.

## Sintoma, para reconhecer da próxima

- Várias "tarefas em execução" que ninguém lembra de ter armado.
- `ps` mostrando só `sleep N` como filho.
- O arquivo que o laço observa **existe**, mas com conteúdo de outro assunto — o do erro.
- Ao matar, o exit é 144 (SIGTERM na espera), nunca um veredito do trabalho real.

## Variante: o positivo OBSOLETO (2026-09-07, #2342)

O laço acima falha por **nunca desistir**. Há o espelho, e ele é pior de detectar: o laço
**desiste cedo**, anunciando um desfecho que é de OUTRO run.

Reusei o mesmo caminho de saída (`verif.exits`) entre duas invocações da verificação. A segunda
ficou ~20min na fila do `heavy` sem escrever nada — e o `FIM` que a primeira havia deixado
continuava lá. O monitor casou `grep -q '^FIM$'`, anunciou "terminou" e devolveu os números
anteriores, idênticos, para um run que não tinha começado.

O que desmentiu não foi o marcador, foi a EVIDÊNCIA: o log apontava `.not.toMatch(/-/)` numa
linha cujo código eu já havia substituído. Aceitar o veredito teria feito eu caçar um bug já
consertado — e relatar a mesma falha duas vezes como se fossem duas.

**Regra:** o marcador de fim tem de ser **daquele** run, não do caminho. Ou apague a saída antes
de armar o laço (e case sobre AUSÊNCIA real), ou carimbe um id de run no marcador e case o id.
Um `FIM` sem identidade é história se passando por presente.

**Sintoma:** o desfecho chega rápido demais para o trabalho que alega descrever, e os números
batem **exatamente** com os da rodada anterior.
