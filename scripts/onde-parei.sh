#!/usr/bin/env bash
# onde-parei.sh — sonda DETERMINÍSTICA do lado RECEPTOR de um "retome": o que
# este worktree tem em voo, em UMA chamada, sem reconstruir de memória.
#   exit 0 = HÁ trabalho a retomar (listado abaixo do cabeçalho)
#   exit 3 = CONSULTEI TUDO e NÃO há nada a retomar (worktree limpo, sem PR,
#            sem scratchpad, sem transcrição anterior com conteúdo)
#   exit 6 = NÃO CONSEGUI CONSULTAR (sem git/gh, fetch falhou): estado
#            DESCONHECIDO — nunca traduza isto como "nada a retomar"
#   exit 64 = uso errado
#
# Uso: scripts/onde-parei.sh [caminho-do-worktree]   (default: cwd)
#
# Por quê (2026-09-05): "retome" numa sessão recém-criada custou 3 chamadas e
# um Python ad-hoc só pra provar que não havia nada. Com ~90 worktrees e ~50
# sessões vivas isso repete o dia todo. As skills existentes cobrem o lado
# EMISSOR (/handoff-sessao, /context-save); esta é a sonda do lado que recebe.
# 3 ≠ 6 pelo mesmo motivo do pr-watch.sh: sonda que falha e diz "nada" é a
# armadilha de sonda ausente (CLAUDE.md §Armadilhas).
set -uo pipefail

WT="${1:-$PWD}"
INVOCADO_DE="$PWD"
[ -d "$WT" ] || { echo "uso: $0 [caminho-do-worktree]" >&2; exit 64; }
cd "$WT" || exit 64
# sondando o PRÓPRIO worktree da sessão, ou outro? muda quem é "a atual".
MESMO_WT=0
[ "$(pwd -P)" = "$(cd "$INVOCADO_DE" 2>/dev/null && pwd -P)" ] && MESMO_WT=1

ind() { printf '%s\n' "$1" | sed 's/^/     /'; }
falha() { echo "❓ NÃO CONSEGUI CONSULTAR: $*" >&2; echo "   estado DESCONHECIDO — não é 'nada a retomar'." >&2; exit 6; }

command -v git >/dev/null 2>&1 || falha "git ausente"
command -v gh  >/dev/null 2>&1 || falha "gh ausente (PR não pôde ser consultado)"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || falha "$WT não é um worktree git"

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || falha "não li a branch"
git fetch -q origin 2>/dev/null || falha "git fetch origin falhou (offline?)"

achou=0
echo "📍 $WT"
echo "   branch: $BRANCH"

# 1. commits à frente da main
AHEAD=$(git log --oneline origin/main..HEAD 2>/dev/null) || falha "git log origin/main..HEAD falhou"
if [ -n "$AHEAD" ]; then
  achou=1; echo "🔸 commits à frente de origin/main:"; ind "$AHEAD"
else
  echo "   commits à frente de origin/main: nenhum"
fi
echo "   atrás de origin/main: $(git rev-list --count HEAD..origin/main) commit(s)"

# 2. mudanças não commitadas
DIRTY=$(git status --porcelain 2>/dev/null) || falha "git status falhou"
if [ -n "$DIRTY" ]; then
  achou=1; echo "🔸 mudanças NÃO commitadas:"; ind "$DIRTY"
else
  echo "   working tree: limpo"
fi

# 3. PRs desta branch (qualquer estado) — gh precisa RESPONDER, não só existir
PRS=$(gh pr list --head "$BRANCH" --state all --json number,state,isDraft,title \
      --jq '.[] | "#\(.number) \(.state)\(if .isDraft then " DRAFT" else "" end) — \(.title)"' 2>&1) \
  || falha "gh pr list falhou: $PRS"
if [ -n "$PRS" ]; then
  achou=1; echo "🔸 PRs da branch:"; ind "$PRS"
else
  echo "   PRs da branch: nenhum"
fi

# 4. scratchpad(s) desta sessão/worktree
SLUG=${WT//[\/.]/-}
SCRATCH_ROOT="/private/tmp/claude-501/$SLUG"
if [ -d "$SCRATCH_ROOT" ]; then
  # tasks/*.output é ruído do harness (saída de Bash em background) — toda sessão gera; não é trabalho
  SCRATCH_FILES=$(find "$SCRATCH_ROOT" -type f -not -path '*/tasks/*' 2>/dev/null | head -20)
  if [ -n "$SCRATCH_FILES" ]; then
    achou=1; echo "🔸 arquivos no scratchpad:"; ind "$SCRATCH_FILES"
  else
    echo "   scratchpad: vazio"
  fi
else
  echo "   scratchpad: não existe"
fi

# 5. transcrições ANTERIORES deste worktree (sinal de arqueologia)
#
# A sessão ATUAL não é história e tem de sair da conta. Ela é identificada por
# CLAUDE_CODE_SESSION_ID, que é o basename do .jsonl (conferido 2026-09-05 —
# a var NÃO está na doc pública, daí a degradação abaixo). Contar tudo e
# subtrair 1 "porque uma delas é a atual" era errado no uso DOCUMENTADO
# `onde-parei.sh <outro-worktree>`: ali NENHUMA é a atual, o -1 come uma
# sessão real e, com n=1 (worktree limpo, sem PR), zerava a conta e a sonda
# saía 3 = "nada a retomar" por cima de uma transcrição inteira.
PROJ_DIR="$HOME/.claude/projects/$SLUG"
ATUAL="${CLAUDE_CODE_SESSION_ID:-}"
if [ -d "$PROJ_DIR" ]; then
  n=0
  while IFS= read -r f; do
    id=$(basename "$f" .jsonl)
    # a sessão que está sondando agora não é trabalho a retomar
    [ -n "$ATUAL" ] && [ "$id" = "$ATUAL" ] && continue
    # só conta sessão com ≥1 chamada de ferramenta — sessão que só abriu não é história
    grep -q '"tool_use"' "$f" 2>/dev/null || continue
    n=$((n+1))
    [ "$n" -le 5 ] && echo "   transcrição: $id ($(wc -c <"$f" | tr -d ' ') bytes, $(stat -f '%Sm' -t '%d/%m %H:%M' "$f"))"
  done < <(ls -t "$PROJ_DIR"/*.jsonl 2>/dev/null)
  # Sem a var não dá para identificar a atual. A heurística velha (descontar 1)
  # só é defensável sondando o PRÓPRIO worktree; em outro, descontar inventa
  # uma sessão atual que não existe ali — e o erro cai para o lado do fail-open.
  if [ -z "$ATUAL" ] && [ "$MESMO_WT" = 1 ] && [ "$n" -gt 0 ]; then
    n=$((n-1)); echo "   (CLAUDE_CODE_SESSION_ID ausente — descontei 1 por heurística)"
  fi
  if [ "$n" -gt 0 ]; then
    achou=1; echo "🔸 $n sessão(ões) ANTERIOR(es) com trabalho neste worktree — arqueologia possível (search_session_transcripts)"
  else
    echo "   sessões anteriores com trabalho: 0"
  fi
else
  echo "   transcrições: nenhuma"
fi

echo
if [ "$achou" = 1 ]; then
  echo "▶ HÁ TRABALHO A RETOMAR (itens 🔸 acima)."; exit 0
else
  echo "∅ NADA A RETOMAR — worktree limpo, sem PR, sem scratchpad, sem sessão anterior."; exit 3
fi
