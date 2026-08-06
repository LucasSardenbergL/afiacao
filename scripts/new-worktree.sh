#!/usr/bin/env bash
# new-worktree.sh — cria uma worktree ISOLADA pra rodar uma sessão Claude sem
# colidir com outras. Cada sessão num working tree próprio = branches nunca se
# cruzam (ver CLAUDE.md §14 + o hook concurrent-session-guard).
#
# Uso:  bun run wt <nome-da-branch> [base-ref]
#   bun run wt feat/minha-feature                  # base = origin/main (limpo)
#   bun run wt fix/x feat/carteira-omie-...         # base = branch existente
#
# A worktree é criada como SIBLING do repo principal: ../<repo>-<slug>.

set -euo pipefail

name="${1:-}"
if [ -z "$name" ]; then
  echo "uso: bun run wt <nome-da-branch> [base-ref]" >&2
  echo "  ex.: bun run wt feat/minha-feature        # base origin/main" >&2
  echo "       bun run wt fix/x feat/outra-branch    # base custom" >&2
  exit 1
fi
base="${2:-origin/main}"

# Ancora SEMPRE no repo principal (não no worktree atual): o git-common-dir
# aponta pro .git principal, mesmo quando invocado de dentro de uma worktree.
common_git=$(git rev-parse --git-common-dir)
case "$common_git" in
  /*) ;;
  *) common_git="$(pwd)/$common_git" ;;
esac
main_root=$(cd "$(dirname "$common_git")" && pwd)
repo_name=$(basename "$main_root")
slug=$(printf '%s' "$name" | tr '/' '-')
dir="$(dirname "$main_root")/$repo_name-$slug"

git fetch origin --quiet
git worktree add -b "$name" "$dir" "$base"

# worktree nasce pronto: deps instaladas na criação (senão o 1º typecheck da
# sessão dá "Cannot find module" — falso vermelho; já custou 3× install manual)
echo "→ instalando deps (bun install)…"
( cd "$dir" && bun install ) || echo "⚠️ bun install falhou — rode manualmente: cd \"$dir\" && bun install"

cat <<EOF

✅ worktree criada (deps instaladas)
   pasta:  $dir
   branch: $name (a partir de $base)

Próximos passos:
   cd "$dir"
   claude             # abra a sessão AQUI (isolada, sem colidir com outras)
EOF
