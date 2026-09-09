# O trap rodou, restaurou — e o script seguiu vivo mutando (2026-09-08)

`scripts/mutcheck.sh` prometia no cabeçalho: *"backup-por-cópia + trap: NUNCA deixa o arquivo de
produção mutado, nem em Ctrl-C"*. A promessa era falsa, e o jeito como era falsa importa: **não
foi o trap que faltou — foi o trap que rodou e não encerrou.**

## O que aconteceu

Um `bun run mutcheck` em background levou SIGTERM externo depois de 22 dos 25 contratos:

```
error: script "mutcheck" was terminated by signal SIGTERM (Polite quit request)
```

Depois disso, `git status` mostrava `M .claude/hooks/destructive-bash-guard.sh` — o **hook de
segurança** com `hookEventName` trocado de `PreToolUse` para `PostToolUse`, exatamente a mutação
de `scripts/mutcheck.d/destructive-bash-guard.mut:35`. Com `PostToolUse` o `deny` não bloqueia:
o guard de comando destrutivo ficou **desarmado no disco**. Um `git add -A` posterior varreu a
mutação para dentro de um commit; num repo com auto-merge, isso chega na main.

## A causa (reproduzida, não deduzida)

```bash
trap 'restore; rm -f "$BACKUP"' EXIT INT TERM     # o código de antes
```

**Em bash, um trap de INT/TERM NÃO encerra o script.** O handler roda e a execução segue da
instrução seguinte. Prova mínima:

```
A: antes
  [trap rodou]                          <- SIGTERM chegou aqui
B: DEPOIS do sleep — o script CONTINUOU
C: fim normal
  [trap rodou]                          <- e o EXIT ainda roda no fim
```

O script saiu **0**. Encadeando: no SIGTERM o handler restaurava **e apagava o BACKUP**; o
processo seguia vivo; a `perl -i` da mutação seguinte mutava o fonte; e todo `restore` virava
`cp <inexistente>`, que só reclama em stderr. Fim: arquivo de produção mutado, exit 0.

**A ORDEM do sinal decide.** Chegando com o fonte já mutado, o próprio handler restaura por
último e o disco fica limpo — benigno. Chegando **antes da 1ª mutação** (baseline, ou entre
mutações), apaga o backup e condena tudo o que vier depois. Meu primeiro teste matava na ordem
benigna e passava VERDE contra o código quebrado: **um teste de sinal que não escolhe a janela
não testa nada.**

## O conserto — três camadas, nenhuma cobrindo a outra

1. **INT/TERM apenas `exit`**; quem restaura e limpa é o trap EXIT, uma vez só.
2. **`restore` CONFERE com `cmp`** e grita `MUTCHECK-FALHA-AO-RESTAURAR`. Devolver 0 sem conferir
   é o mesmo fail-open um andar acima — o `cp` pode falhar calado.
3. **SIGKILL não passa por trap nenhum**: nada dentro do processo evita o resto de mutação. Então
   quem recusa é a rodada **seguinte** — sentinela em disco (`MUTCHECK-RESTO-DE-MUTACAO`),
   fail-CLOSED, com o comando de recuperação impresso.

E `mutcheck-all.sh` repassa o sinal ao filho e **espera**: sem o PID (invocação em foreground) um
SIGTERM só no pai deixava o `mutcheck.sh` órfão restaurando com o log já fechado.

## O que a falsificação ensinou (duas vezes)

**A primeira rodada apagou o próprio conserto.** `restaurar()` era `git checkout --` e o bloco de
teste novo ainda não estava commitado — a primeira linha do laço o varreu, e as sabotagens
seguintes rodaram contra a versão velha. É literalmente o aviso que já estava no CLAUDE.md
("COMMITE antes de falsificar"); pisei nele mesmo assim. **Sintoma de reconhecimento: sabotagens
diferentes falhando todas do mesmo jeito.**

**A segunda rodada reprovou meu teste, não o código.** Desligar o `exit 3` do guard de entrada
deixava o gate VERDE: eu afirmava a **string do aviso**, e a mensagem continuava saindo. O gate
passou a afirmar comportamento — `exit 3` **e** o backup ainda com o conteúdo original (se a
rodada seguisse, o `cp` inicial sobrescreveria o backup bom com o mutado e destruiria a única via
de volta).

## A regra que fica

- `trap ... INT TERM` que não termina em `exit` é **fail-open**: o handler vira só um interlúdio.
- Restaurar sem **conferir** é o mesmo fail-open um andar acima.
- Contra SIGKILL não há trap: a proteção é a **rodada seguinte recusar**, com sentinela em disco.
- Teste de morte por sinal precisa **escolher a janela** (com espera por condição, teto e ramo que
  diz "não consegui") — matar na hora errada aprova código quebrado.
