#!/usr/bin/env bash
# migration-immutability-guard.sh — PreToolUse(Write|Edit|MultiEdit): migration committed é imutável.
#
# Bloqueia MODIFICAR uma migration que JÁ está no HEAD (committed). O snapshot supabase/migrations/
# é a fonte de DR (CLAUDE.md / database.md) e o apply é manual no SQL Editor — editar um .sql já
# committado diverge repo×banco e NÃO re-aplica. Correção é SEMPRE uma migration NOVA.
#
# Escopo estreito: só file_path ~ supabase/migrations/*.sql QUE EXISTE no HEAD. Migration nova
# (não-committed/untracked) passa — preserva o fluxo lovable-db-operator (criar/iterar antes do
# commit). Complementa migration-collision-guard (aquele olha CONTEÚDO p/ colisão RED entre
# worktrees; este olha se-o-arquivo-já-é-committed).
#
# Fail-open: sem jq/git, fora de repo, path irresolvível, ou qualquer erro → exit 0 (nunca trava
# trabalho por bug do próprio guard). Fail-closed na DECISÃO: committed reconhecido → deny.
# Espelha o collision-guard: exit 0 + JSON permissionDecision="deny".
# Testes em scripts/test-migration-immutability-guard.sh.
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
fpath="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

# só age em migrations
case "$fpath" in
  */supabase/migrations/*.sql | supabase/migrations/*.sql) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$root" 2>/dev/null || exit 0

# Resolução FÍSICA do path (Codex 2026-06-24): string-strip de prefixo (${fpath#$root/}) é
# bypassável — './'-prefix, symlink, ou CLAUDE_PROJECT_DIR ≠ toplevel do git → rel errado →
# cat-file falha → allow indevido. Deriva rel do TOPLEVEL físico real; `pwd -P` resolve symlink.
top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
toptop="$(cd "$top" 2>/dev/null && pwd -P)" || exit 0
fdir="$(cd "$(dirname "$fpath")" 2>/dev/null && pwd -P)" || exit 0   # dir inexistente → allow (nova)
abs="$fdir/$(basename "$fpath")"
case "$abs" in
  "$toptop"/*) rel="${abs#"$toptop"/}" ;;
  *) exit 0 ;;   # fora do repo / irresolvível → fail-open
esac

# o arquivo existe no HEAD? (committed) — só então é imutável. Nova/untracked → fail-open (allow).
git -C "$toptop" cat-file -e "HEAD:$rel" 2>/dev/null || exit 0

reason="Migration committed é imutável: $rel já está no HEAD.

O snapshot supabase/migrations/ é a fonte de DR e o apply é manual (SQL Editor) — editar um .sql já committado diverge repo×banco e NÃO re-aplica. Correção = uma migration NOVA (use a skill lovable-db-operator). Só inspeção/leitura? Abra o arquivo, não use Edit/Write."
jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
