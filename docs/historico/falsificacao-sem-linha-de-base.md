# Falsificação sem linha de base — "ficou vermelho" só é informação se existir um verde do qual sair

**2026-09-05.** Os 5 arneses do `bun run test:falsificacao` sabotavam o alvo uma regra por vez e
exigiam vermelho de cada sabotagem — **sem nunca afirmar que a suíte estava VERDE antes dela**.
Falsificação sem linha de base prova que o teste **reage**, não que ele estava **certo antes de
reagir**: um arnês incondicionalmente vermelho aprova com louvor, porque toda sabotagem produz o
vermelho exigido e o gate anuncia "todas as sabotagens ficaram vermelhas". É a mesma família de
`ausente ≠ zero`.

Ao instrumentar o guard de fuso do #2203 a hipótese foi levantada assim: *"o CI roda os arneses só
com `--falsificar` e nunca verifica a baseline verde"*. Ao medir, **duas partes da premissa caíram
— e o furo que sobrou era pior do que o descrito**.

## O que a medição corrigiu

**1. A baseline verde JÁ roda no CI.** Os 5 arneses estão no 2º laço do `test:hooks`
(`package.json`), que é um step **anterior** ao `test:falsificacao` no **mesmo job** `validate`, sem
`continue-on-error` e sem `if:`. Um arnês incondicionalmente vermelho reprova o CI — no step de
antes. A propriedade de bloqueio estava intacta; o que não existia era a **asserção**.

**2. `psql-ro-error-stop` já nascera com linha de base** — o bloco `(A) EXPECTATIVA` roda antes de
qualquer `sed` e soma em `FALHAS`. Faltava só **abortar**: com (A) vermelho ele seguia para (B)
imprimindo `✅ camada sabotada → VERMELHO` sobre camadas que ninguém mediu — veredito fabricado.

## O furo que sobrou: a baseline do `test:hooks` é OUTRA invocação

O `test:hooks` roda a suíte no **locale ambiente** e sobre o **alvo real**. O laço de sabotagem roda
outra coisa: `LC_ALL=<loc> <OVERRIDE>=<cópia em $tmp> bash "$0"`. Se for **essa** invocação que está
vermelha por motivo alheio à sabotagem — locale ausente, cópia sem `chmod +x`, override que muda um
caminho — o `test:hooks` fica **verde** e todas as sabotagens "passam" de graça.

Por isso o conserto **não** foi no runner (`test.sh && test.sh --falsificar`): isso duplicaria o
`test:hooks` a custo cheio e rodaria justamente a invocação **errada**. O controle foi para dentro
de cada arnês, com a **mesma invocação do laço de sabotagem** e a sabotagem trocada por **nada**,
abortando antes do primeiro `sed`. `package.json` e `.github/workflows/ci.yml` — os dois arquivos
quentes — ficaram intocados.

## O controle pegou um bloco VAZIO na primeira execução

`test-fecho-edges-pendentes.sh --falsificar` ficou **vermelho no controle, nos 2 locales**, com a
suíte crua verde. Causa: a cópia sabotada morava em `"$tmp"` raso, e `edges-pendentes.sh` deriva o
binário auxiliar (`scripts/edges-afetadas.ts`) de `$0` e **não** de `$RAIZ` — de propósito, porque a
suíte aponta `$RAIZ` para um repo-fixture. A cópia em `$tmp` fazia esse caminho apontar para fora do
repo, o `[ ! -f "$AFETADAS_TS" ]` fechava fail-closed com `exit 2`, e as **22 sabotagens ficavam
vermelhas sem ter sabotado nada**. O bloco anunciava "todas as sabotagens ficaram vermelhas" havia
meses sem medir nada, e o `test:hooks` não via — lá o alvo está no lugar certo.

**O custo denunciava o furo, e ninguém tinha olhado:** com o bloco vazio o `--falsificar` levava
~40s; com a árvore-espelho (mesma profundidade do alvo + symlink para o `scripts/` real) ele leva
**480s**. Um gate 12× mais barato do que deveria é um gate que não está rodando o que diz rodar.

## A falsificação da asserção nova

A asserção é *"arnês com a SUÍTE incondicionalmente vermelha REPROVA"*. Provada sabotando a **suíte**
(não o alvo) — `ok()` passa a marcar `fail=1`, o análogo de fixture podre — e comparando as duas
versões, nos **2 locales** (#1483):

| | `origin/main` (antes) | `HEAD` (depois) |
|---|---|---|
| `read-contexto-nudge --falsificar` | **exit 0 — aprovou** | exit 1, pela marca do controle |
| `fecho-edges-pendentes --falsificar` | **exit 0 — aprovou** | exit 1, pela marca do controle |

Script da falsificação (transitório, scratchpad): sabota `^ok()  { printf` → `ok()  { fail=1; printf`
numa cópia do arnês em `scripts/`, roda `--falsificar` sob `LC_ALL=C` e `LC_ALL=pt_BR.UTF-8`, e exige
exit 0 na versão da main e exit 1 **com** a marca ASCII `controle SEM sabotagem ja esta VERMELHO` no
HEAD — reprovar sem a marca seria vermelho pelo motivo errado.

## O outro lado do laço: a RESTAURAÇÃO também precisa de controle (2026-09-07)

O controle protege a ENTRADA do laço. A saída ficou descoberta, e cobrou.

Falsificando o `REESCRITA_BASELINE_OBSOLETA`, a etapa de atribuição — *"sem o código novo isto
passa verde?"* — usou `git checkout HEAD~1 -- scripts/authz-gate-check.ts`. Esse comando **escreve
no ÍNDICE**, não só no working tree. O `restaurar()` seguinte era `git checkout -- <path>`, que
restaura **do índice** — ou seja, restaurou a versão sabotada por cima dela mesma. O laço imprimiu
`RESTAURADO: exit 0` e terminou "verde".

Dois agravantes, e nenhum é sobre git:

1. **O verde final não distinguia.** Com a baseline já podada, `authz:check` sai 0 *com ou sem* o
   gate novo — o controle de restauração media uma coisa que era verdadeira dos dois lados. É o
   mesmo defeito do controle de entrada, espelhado: asserção que não separa os ramos.
2. **O commit seguinte arrastou a reversão.** `git add <outro-arquivo> && git commit` commita o
   ÍNDICE INTEIRO. O commit "regrava o carimbo" saiu carregando `authz-gate-check.ts | 33 +----`,
   apagando a entrega do commit anterior. Só apareceu porque uma conferência de colisão listou os
   arquivos do PR e o arquivo principal **não estava lá**.

Correções que ficam, e a segunda é a que generaliza:

- **Restaure por CÓPIA (`cp` de um backup), nunca por `git checkout`** dentro de um laço de
  sabotagem. O git carrega estado (índice) que o laço não modela.
- **A restauração se prova por CONTEÚDO, não por "o `cp` rodou":** exija a marca do código de volta
  (`grep -c MARCA == n`) e `git diff --quiet`. "Restaurei" sem asserção é a mesma família de
  `ausente ≠ zero` — ausência de erro no `cp` não é presença do arquivo certo.

## A regra

**Arnês de falsificação começa com um CONTROLE**: a mesma invocação do laço de sabotagem, com a
sabotagem trocada por nada, exigida VERDE nos 2 locales, **abortando antes do primeiro `sed`**. Sem
ele o relatório de sabotagem é fabricado, e a suíte que roda em outro lugar (`test:hooks`) não cobre
esse buraco. Corolário barato: **se o `--falsificar` ficar muito mais rápido do que n×2 execuções da
suíte, ele não está rodando a suíte** — meça o tempo, é o sensor mais barato que existe.

**E termina com um CONTROLE DE SAÍDA**: a restauração é asseverada pelo conteúdo do arquivo e por
`git diff --quiet`, não pelo exit do `cp` — e a sabotagem nunca passa pelo índice do git, senão o
próximo `git commit` de qualquer outra coisa a leva junto.
