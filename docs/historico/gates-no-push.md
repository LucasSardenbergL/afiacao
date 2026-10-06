# O vermelho que o CI mostrava em 36 min e um script acha em 98 ms: gates baratos antes do `git push` (2026-09-26)

A pergunta do founder foi *"auto-fix em todos os PRs é possível?"*. É, com Routine disparada por
workflow (o gatilho GitHub das Routines só aceita `pull_request`/`release`, não "CI falhou"). Só
que, com auto-merge ligado, auto-fix significa **merge sem ninguém olhar**: o conserto mecânico de
um gate que existe para forçar decisão consciente (fingerprint, baseline, índice) é justamente o
que o derrota. Antes de pôr agente no laço, medimos o que deixa PR vermelho.

## A medição (MCP GitHub, read-only; 300 runs do `ci.yml` em `pull_request`, 170 PRs mergeados de 08 a 26/09)

- **Taxa:** nos últimos 10 dias, **3 de 45** PRs mergeados (7%) tiveram `validate` vermelho antes
  do merge, e nenhum foi fechado sem merge. Em 18 dias foram 41/170 (24%), caindo por regime: 39%
  (08–09/09) → 21% (10–15/09) → 7% (16–26/09).
- **Demora:** da 1ª falha bloqueante ao merge, mediana de **50 min** (n=41), p75 ≈ 9 h, 3 PRs
  passaram de 24 h. A sessão dona já resolve a mediana; o custo está na cauda.
- **Onde:** 63 dos 83 runs bloqueantes (76%) caíram em `gates-e-falsificacao`; typecheck, 0.
- **Por quê (13 logs lidos):** 8 falhas mecânicas (`docs:citacoes` ×3, `docs:indice` ×2,
  fingerprint, knip, exclusividade), 3 testes falhando de verdade, 2 de infra. Os ~70% mecânicos
  do todo são extrapolação dessa amostra.
- **Ruído que não bloqueia:** 37 dos 120 runs vermelhos falharam só no `mutation-check`, que fica
  fora do `validate`. E boa parte do vermelho de 08–09/09 foi o MESMO gate quebrado em ≥4 branches
  na mesma hora: defeito da main, não de PR. Um autofix por PR teria aberto uma sessão por
  branch para remendar a mesma coisa.

## O caso que fechou a conta

O [#2565](https://github.com/LucasSardenbergL/afiacao/pull/2565) (money-path) ficou vermelho por
`docs:indice`: faltava a linha do doc novo no índice. O step executou em **40 ms**, mas o PR foi
aberto às 01:19 UTC e o vermelho só apareceu às 01:55: **36 min** para um veredito que cabia no
push. Medido localmente: `docs:indice` 98 ms, `docs:citacoes` 2,1 s, `sonda:fingerprint` 138 ms.
Esses três cobrem 6 das 8 falhas mecânicas da amostra.

## O que entrou (fase 0)

- **`.claude/hooks/push-gates-guard.sh`** (PreToolUse/Bash): em `git push` do HEAD atual, roda os
  três gates. **Nega** só com árvore limpa **e** evidência positiva (exit 1 + a marca de falha do
  gate: texto ASCII fixo). Com árvore suja (inclusive o `add && commit && push` de um comando só,
  que o hook vê antes do commit), só **avisa**, porque os gates leem o disco. Gate que não rodou
  (bun ausente, crash, timeout) → fail-open. `--no-verify` é a válvula. Vale para toda sessão,
  local ou cloud, porque o `settings.json` é versionado; o repo não tinha hook de git nenhum.
- **Prova:** `scripts/test-push-gates-guard.sh` (53 casos, no `test:hooks`) com repo fixture e
  gates stubados, controle verde primeiro. A sentinela de deriva roda o `docs:indice` REAL
  (controle verde e sabotagem na mesma invocação) e confere as marcas dos outros dois nas linhas
  de `console.error`. Na falsificação, 13 sabotagens de uma camada por vez, em `LC_ALL=C` e
  `C.UTF-8`: 12 ficaram vermelhas e 1 verde de propósito. Remover o `command -v bun` é
  redundante: sem bun, o gate sai 127, que não é veredito, e o laço já faz fail-open. No
  ponta a ponta com os gates reais, um doc sem linha no índice num worktree descartável foi
  **negado** com a mensagem do próprio gate.
- **Vigia de PR em sessão cloud:** lá não há `gh`, e o `pr-watch.sh` sai 64. A regra passou a
  ser `subscribe_pr_activity` sem perguntar, mais um `send_later` para conflito, que não gera
  evento (`docs/agent/worktrees.md`).

## Limites conhecidos

O hook só cobre esses três gates; knip, exclusividade e testes seguem no CI. No comando único
`add && commit && push` ele avisa em vez de negar, mas o aviso chega junto com o push, não 30
min depois. Uma marca que mude de texto deixaria o hook calado, e é isso que a sentinela de
deriva prende.

## Quando medir (fase 1+ só com sinal desta)

Daqui a ~7 dias, rodar numa sessão local, onde há `gh`:

```bash
gh run list --workflow ci.yml --event pull_request --status failure --limit 200 \
  --json databaseId,headBranch,createdAt \
  | jq -r '.[] | select(.createdAt >= "2026-09-27") | .databaseId' \
  | while read -r id; do
      gh run view "$id" --log-failed 2>/dev/null \
        | grep -oE 'script "(docs:indice|docs:citacoes|sonda:fingerprint)" exited' | sort -u
    done | sort | uniq -c
```

O denominador vem do mesmo `gh run list` sem `--status failure`. Se o vermelho desses três
gates for a ~0 e o vermelho bloqueante restante ficar abaixo de ~5% dos PRs, o autofix como
**resgate de PR parado** (carência de ~2 h, teto de 2 tentativas, money-path em draft, uma
correção na main por falha sistêmica) provavelmente não compensa. Se a cauda de PRs parados por
horas persistir, ele volta à mesa.

## A medição (2026-10-03) e o porquê (2026-10-05)

**Medido** (MCP GitHub, 322/322 runs do `ci.yml` em `pull_request`, janela 26/09 12:00Z → 03/10):
**33 de 157** PRs mergeados (21%) tiveram `validate` vermelho antes do merge (base: 3/45, 7% — o
volume triplicou, as janelas não se comparam limpo). Os 3 gates do hook derrubaram **12 PRs**
(9 causas distintas: o fingerprint de 27/09 caiu em 3 branches na mesma hora, defeito da main).
Da 1ª falha ao merge, mediana **110 min** (n=33), máximo ~40 h. Logs lidos em 14 dos 89 jobs; o
resto classificado pelo step, que bateu 1:1 com o log nos 14.

**Por quê o hook não barrou:** reproduzido numa worktree descartável, ele NEGA com a árvore limpa
nas três formas de push. Mas 96 dos 98 commits dos 12 PRs têm committer humano e sem assinatura
(sessão LOCAL, no Mac — a nuvem commita como `Claude`). Dois buracos que o fixture não via:

- **`bun` fora do PATH do hook.** O hook herda o PATH do processo do Claude Code, não o do zsh;
  o app aberto pelo Dock não lê o `~/.zshrc`, e o bun mora em `~/.bun/bin`. Sem bun, o hook saía
  `exit 0` CALADO — e "calado" não se distingue de "passou". (Hipótese mais provável, não provada
  daqui; o aviso novo é o que a prova na próxima vez.)
- **`add && commit && push` num comando só** só avisava — e o aviso chega junto do push.

**Conserto:** o hook procura o bun também em `~/.bun/bin`, `/opt/homebrew/bin` e
`/usr/local/bin`, e quando não acha (ou um gate não dá veredito) AVISA que não checou. No comando
único, se o commit do PRÓPRIO comando cobre toda a sujeira com prova (`add -A`/`.` na raiz,
`add -u`/`commit -a`, caminho literal, ou já staged), o disco vira o HEAD → NEGA. Glob, `add -p`,
`commit <caminho>` e add fora da raiz seguem só avisando. Falsificação: 10 sabotagens, uma camada
por vez, vermelhas em `LC_ALL=C` e `C.UTF-8` com controle verde no início e no fim; a guarda de
glob saiu porque ficou VERDE (o casamento já é literal — redundante).

**Fase 2 (autofix):** fora da mesa pela regra de máquina meta (CLAUDE.md): CI vermelho não é
incidente, e o vermelho de uma máquina não justifica outra.
