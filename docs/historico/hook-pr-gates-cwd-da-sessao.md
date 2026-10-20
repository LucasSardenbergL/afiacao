# Hook `pr-collision-guard`: os gates rodavam no checkout PRINCIPAL, não no worktree (2026-10-20)

Incidente: ao criar o PR #3201 a partir do worktree `compassionate-gagarin-57eb11`, o hook pré-`gh pr create`
negou com `✗ casts:stale … rodados em /Users/lucassardenberg/Projetos/afiacao` — o gate passava no worktree
(15/15 `gates:rapidos`) e o PR saiu pela válvula `GATES_RAPIDOS=pular`. O vermelho era do **checkout principal**,
parado 65 commits atrás de `origin/main` (HEAD solto em `8583694a7`, de 2026-10-18).

## O diagnóstico (o que NÃO era, com a prova de cada um)

| hipótese | teste | resultado |
|---|---|---|
| cópia velha do hook no principal | `git log 8583694a7..origin/main -- .claude/hooks/pr-collision-guard.sh` | zero commits; `cmp` = IGUAIS |
| `perl` ausente no PATH do hook (o parse do `cd` literal é em perl) | `cd $S/fakeroot && gh pr create --help` (cd com `$`) | "não consegui resolver o `cd`" → o parse RODOU |
| `GIT_WORK_TREE`/`GIT_DIR` herdados (fariam `rev-parse --show-toplevel` devolver o principal) | `ps -E` do processo do hook, amostrado em background durante o disparo | PATH, PWD e CLAUDE_PROJECT_DIR = principal; **nenhuma `GIT_*`** |
| ambiente do processo | replay da cópia do principal com `env -i`, o PATH capturado e cwd no principal | resolve o **worktree** |
| **o harness remove o `cd <cwd da sessão> &&` inicial antes de entregar o comando ao hook** | `true; cd <wt> && gh pr create --help` (o `cd` deixa de ser o 1º segmento) | **mudo** — gates rodaram no worktree e passaram; o mesmo comando sem o `true;` nega "no principal" |

Com o `cd` removido, o hook caía em `gdir="$PWD"` — e o `$PWD` de um hook no app é `CLAUDE_PROJECT_DIR`, o
checkout principal. O `push-gates-guard.sh` já fazia certo (`.cwd` do JSON, `$PWD` só como fallback).

## A correção

`gdir` parte do **`.cwd` do JSON** (o cwd da sessão, que o harness manda junto) e só cai em `$PWD` se
ausente; o `cd <literal>` continua sobrescrevendo. Dois casos novos em `scripts/test-pr-collision-guard.sh`
(`_hook` ganhou o 3º argumento = `cwd` do JSON): sem `cd` → gates no cwd da sessão; com `cd` → o `cd` vence.
**Falsificação:** `gdir="$PWD"` de volta → o caso novo FAIL (`gates rodaram em '<raiz do repo>'`) e a suíte sai 1.

## O que a correção NÃO resolve sozinha — e a pendência real

Hooks do app rodam a cópia de **`$CLAUDE_PROJECT_DIR/.claude/hooks/`** = o checkout principal. Enquanto ele
ficar em `8583694a7`, TODO worktree roda hooks (e `gates:rapidos`, quando cai no fallback) de 2026-10-18.
O reflog do principal mostra o estado mantido: `checkout: moving from X to origin/main` (HEAD solto em
`origin/main`, que é o que o `/fecho` oferece). Pendência: avançar o principal para `origin/main` depois do
merge deste PR — `git -C /Users/lucassardenberg/Projetos/afiacao checkout --detach origin/main` (nenhuma
sessão Claude tem cwd lá: `lsof -a -d cwd -c claude` lista só worktrees; os PIDs no principal são servidores MCP).

## Lições

- **Hook no app: `$PWD` ≠ cwd da sessão.** O JSON traz `cwd`; é ele o ponto de partida. `$PWD` é o
  `CLAUDE_PROJECT_DIR`.
- **O harness normaliza o comando**: um `cd <cwd> &&` inicial não chega ao hook. Teste de hook que só
  cobre "com `cd` literal" não cobre o caso real da sessão em worktree.
- **Replay offline que passa não absolve o hook**: três réplicas (PATH real, cwd real, `env -i`) resolviam
  certo. O que fechou foi mudar a FORMA do comando ao vivo (`true; cd …`) — um experimento no sistema real
  vale mais que três cópias dele.
- **Checkout principal parado = hooks parados para todos os worktrees.** A `fecho` oferece o `--detach
  origin/main`; quando ninguém fecha sessão por dias, ele fica para trás em silêncio.
