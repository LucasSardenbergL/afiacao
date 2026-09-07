# O guard da 13ª armadilha: quando um padrão de shell VALE um aviso

2026-09-06 · hook [`.claude/hooks/sonda-processo-guard.sh`](../../.claude/hooks/sonda-processo-guard.sh)
· suíte `scripts/test-sonda-processo-guard.sh` · armadilha em
[evidencia-positiva-shell.md §13](evidencia-positiva-shell.md)

A §13 mediu o defeito: `until ! pgrep -f 'mutcheck.sh …'; do sleep 20; done` casou **cinco** PIDs
numa máquina com ~27 sessões vivas, e **nenhum** era o trabalho da worktree. Este doc registra a
decisão de transformar aquela lição em guard — e as três coisas que a entrega ensinou por cima.

## 1. O critério de "vale um aviso?" é a CONJUNÇÃO, e ela se mede no corpus

`pgrep -f` sozinho não é sinal de nada: `.claude/hooks/vigia-worktree.sh` conta sessões vivas com
ele e está certo. O que é assinatura de defeito são três fatos **juntos**:

1. laço `while`/`until`;
2. na **condição**, uma sonda de processo por texto (`pgrep …`, ou `ps` + `grep`);
3. no **corpo**, um `sleep` — é o que faz daquilo uma espera, e não outra coisa.

E a pergunta "isso vai fazer barulho?" tem resposta empírica, não retórica: no corpus do repo
existem **2** usos executáveis de `pgrep`, e **nenhum** casa a conjunção — `vigia-worktree.sh` é
contagem pontual sem laço, `scripts/test-heavy.sh` usa `-P` (por PPID, que identifica uma
EXECUÇÃO, não um padrão de texto). Taxa base de falso positivo medida: **0**. Foi isso, e não a
plausibilidade da ideia, que sustentou a decisão de implementar.

O guard nasce AVISO e **fica** AVISO. Diferente do precedente do PIPESTATUS — que deixou `deny`
como decisão de fase N+1 —, aqui existe um falso positivo legítimo e **permanente**: esperar por um
processo que é de fato único na máquina (um daemon, um app de GUI). Esse caso nunca desaparece,
então a precisão para bloquear nunca vai existir. Dizer isso no cabeçalho vale mais que deixar a
promessa aberta.

## 2. Ao decidir o que o scanner chama de "execução", pese a FREQUÊNCIA, não a possibilidade

A 1ª versão tratou **aspas duplas como executáveis**, com um argumento correto: `bash -c "while
pgrep …; do sleep 5; done"` roda de verdade. A revisão adversária (Codex, enquadramento de
cobertura) mostrou o outro prato da balança — dispararam TODOS estes:

```
git commit -m "docs: until ! pgrep -f X; do sleep 20; done"
echo "until ! pgrep -f X; do sleep 20; done"
grep -nF "until ! pgrep -f X; do sleep 20; done" docs/historico/evidencia-positiva-shell.md
printf "%s\n" "until ! pgrep -f X; do sleep 20; done" > doc.md
```

Ou seja: o precedente de 2026-06-24 — um guard do repo bloqueou o commit que **documentava** o
padrão que ele detectava — voltaria, agora como ruído. E o PR que entrega este hook contém
exatamente essas linhas.

A troca ficou: **aspas duplas passam a ser MENÇÃO**, com uma exceção — `"$(…)"` continua visível,
porque substituição de comando executa e `until [ -z "$(pgrep -f X)" ]` é idiomático demais para
escapar. O preço é `bash -c "…"` virar falso negativo, o que é coerente: reinterpretação posterior
(`eval`, `ssh host "…"`, `xargs`) já estava na lista de limites assumidos.

A regra generalizável: num detector textual, "isto pode ser execução" é a pergunta errada. A certa
é **"com que frequência, NESTE repo, esta forma é execução e com que frequência é menção?"** — e
num repo que documenta as próprias armadilhas, a menção ganha das aspas duplas com folga.

## 3. A regra que estraga uma falsificação pode ser uma OTIMIZAÇÃO, não uma regra de negócio

O catálogo já ensina que a fixture de uma falsificação precisa passar em **todas** as outras
regras, para que só a sabotada decida o resultado
([base](falsificacao-sem-linha-de-base.md)). Nesta entrega, 3 das 7 falsificações ficaram verdes
por engano na 1ª tentativa, e uma delas por um motivo que não estava no catálogo:

| falsificação | por que o verde veio de graça |
|---|---|
| F2 (sonda restrita à condição) | a fixture não tinha `while` com `sleep` no corpo — a sabotagem nem a alcançava |
| F5 (`ps` exige `grep`) | a fixture (`while grep -q '^RC=' .mut1.txt`) não contém `ps` nem `pgrep`, então morria no **portão barato** do hook e nunca chegava ao `awk` sabotado |
| F3/F7 (scanner de aspas) | o `perl` da sabotagem deixou de casar quando o scanner foi reescrito — pego pelo `cmp` que exige que a sabotagem MUDE o arquivo |

A F5 é a lição nova: a "outra regra" que protege a fixture não precisa ser uma regra de decisão —
pode ser o **portão de performance** que existe para o hook não pagar `jq`+`awk` em toda chamada
Bash. Otimização é regra: ela decide, sozinha, o resultado de metade das fixtures possíveis. Ao
escolher a fixture de uma falsificação, verifique que ela atravessa o caminho quente **até** a
regra sabotada — e não só que ela "é do assunto".

O antídoto ficou embutido na suíte: a função `falsifica()` exige, na MESMA invocação, (1) controle
verde com o hook íntegro, (2) `cmp` provando que a sabotagem alterou o arquivo, (3) vermelho depois.
Nenhuma das três sozinha teria pego os três acidentes acima.

## O que a revisão adversária corrigiu (e virou teste)

Caminho absoluto (`/usr/bin/pgrep`, `/bin/sleep`) · barra anti-alias (`\pgrep`) · herestring `<<<`
e shift aritmético `1 << 2` abrindo heredoc fictício · delimitador com hífen (`<<DOC-FIM` lido como
`DOC`, que nunca encontrava o próprio fechamento e engolia o resto do comando) · `pgrep -P "$$"` e
`ps -p "$pid"`, que são **identidade real** e não padrão de texto · e o `set -u` derrubando o hook
inteiro quando `HOME` não existe (fail-CLOSED num sensor). Os limites que ficaram de fora de
propósito estão no cabeçalho do hook, cada um travado por um teste que fica VERMELHO se um dia
forem cobertos.
