# Sonda que desconta "a sessão atual" sem saber qual é ela

**2026-09-05** · `scripts/onde-parei.sh` · sonda de retomada · irmão de [sonda-ausente-em-script-que-apaga.md](sonda-ausente-em-script-que-apaga.md)

## O que aconteceu

O `onde-parei.sh` nasceu no #2182 para responder "Retome" sem reconstruir de memória: exit `0` = há trabalho, `3` = consultei e não há nada, `6` = não consegui consultar. Entre os sinais que ele consulta está a **transcrição de sessões anteriores** do worktree (`~/.claude/projects/<slug>/*.jsonl`).

A contagem era assim: some as transcrições com `"tool_use"`, e reporte `n-1` — **"porque uma delas é a sessão atual"**. Ninguém verificava *qual*; a identidade era **presumida pela contagem**.

A presunção é falsa no uso que o próprio `--help` documenta, `onde-parei.sh <outro-worktree>`: ali **nenhuma** das transcrições é a sessão atual, e o `-1` come uma sessão real. Com `n=1` — worktree limpo, sem PR, uma única sessão anterior — o desconto zera a conta, o gatilho de arqueologia (`n>1`) não arma, e a sonda responde:

```
∅ NADA A RETOMAR — worktree limpo, sem PR, sem scratchpad, sem sessão anterior.
```

...com **1,1 MB de transcrição em disco**. É a armadilha da §Armadilhas do CLAUDE.md — *sonda que falha e diz "nada"* — chegando por um caminho novo: não por a sonda estar **ausente**, e sim por ela **afirmar uma identidade que não consultou**.

## A forma generalizável

> Contagem não identifica. Se o algoritmo é "são N, uma delas é X, logo há N−1", ele está **presumindo X pela cardinalidade** — e erra inteiro no dia em que X não está no conjunto. Ou identifique X (chave exata), ou não desconte.

Aqui a chave exata existe: `CLAUDE_CODE_SESSION_ID` é o basename do `.jsonl` (conferido 2026-09-05). Ela **não está na doc pública** de hooks/settings, então a correção degrada: sem a var, a heurística velha (descontar 1) só vale sondando o **próprio** worktree — em outro, descontar inventaria uma sessão atual que não existe ali, e o erro cairia justamente para o lado do fail-open.

## Como foi medido

O bug foi encontrado **usando** a sonda (um "Retome" sem briefing), não lendo o código. Duas vezes o harness de medição sujou o próprio resultado, o que vale registrar:

1. A varredura de reprodução incluiu o worktree **da sessão que media** — onde o exit 3 é *correto* — e reportou um falso fail-open.
2. Depois da correção, `onde-parei.sh` no próprio worktree passou a sair `0` em vez de `3` — porque as **mudanças desta entrega** o deixaram sujo. Sinal certo, substrato contaminado.

Em ambos, a saída só foi confiável em **substrato virgem**: fixture hermética com `git`/`gh` stubados e `HOME` de teste (`scripts/test-onde-parei.sh`, 13 asserções — a sonda entrou no #2182 **sem teste nenhum**, no caminho crítico de toda retomada).

O poder do teste foi medido, não sentido: `scripts/mutcheck.d/onde-parei.mut` planta 7 regressões — incluindo o bug de origem e a degradação do `gh` quebrado para "sem PR" — e as 7 ficam vermelhas (0 sobreviventes).
