#!/usr/bin/env bash
# test-wt-reap.sh — TDD da decisão de reap (quem matar) do scripts/wt-reap.sh
#
# Regra de ouro: NUNCA matar processo de um worktree com sessão claude viva, nem
# do worktree atual. Só mata dev-proc órfão (worktree do projeto, parado). No
# aninhamento worktree-dentro-de-principal, vale o match MAIS LONGO.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$here/wt-reap.sh" # expõe reap_decide/wt_containing sem rodar main

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

ALL="$tmp/all"
ALIVE="$tmp/alive"
printf '%s\n' /wt/a /wt/b /wt/cur /root /root/.claude/worktrees/x >"$ALL"
printf '%s\n' /wt/a /root >"$ALIVE"
SELF=/wt/cur

# pid <TAB> cwd <TAB> cmd  →  lista de pids-alvo
targets() { printf '%s\n' "$1" | reap_decide "$SELF" "$ALL" "$ALIVE" | cut -f1 | tr '\n' ' '; }
T() { printf '%s\t%s\t%s' "$1" "$2" "$3"; }

want_kill() {
  if targets "$2" | grep -qw "$3"; then echo "  ok    kill  | $1"
  else echo "  FAIL  want kill ($3) | $1"; fail=1; fi
}
want_spare() {
  if targets "$2" | grep -qw "$3"; then echo "  FAIL  want spare ($3) | $1"; fail=1
  else echo "  ok    spare | $1"; fi
}

want_kill  "worktree morto"            "$(T 200 /wt/b 'node vitest')"               200
want_spare "worktree vivo (claude)"    "$(T 100 /wt/a 'node vitest')"               100
want_spare "worktree atual (self)"     "$(T 300 /wt/cur 'node vitest')"             300
want_kill  "subdir de worktree morto"  "$(T 400 /wt/b/src/lib 'esbuild --service')" 400
want_spare "fora de qualquer worktree" "$(T 500 /tmp/rand 'node vitest')"           500
want_kill  "filho morto sob pai vivo"  "$(T 600 /root/.claude/worktrees/x 'esbuild')" 600

echo
if [ "$fail" -eq 0 ]; then echo "PASS — decisão de reap correta"; else echo "FALHOU"; fi
exit "$fail"
