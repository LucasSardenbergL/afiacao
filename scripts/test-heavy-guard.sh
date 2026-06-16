#!/usr/bin/env bash
# test-heavy-guard.sh — TDD do hook .claude/hooks/heavy-guard.sh
#
# Regra: comando PESADO (test/build/typecheck/vitest/tsc) SEM `heavy` → deny.
#        Já com `heavy`, ou leve, ou leitura/menção → allow (não interfere).
#
# Uso: bash scripts/test-heavy-guard.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/heavy-guard.sh"

# o hook só age se `heavy` existir no PATH — põe um stub pra testar a lógica
stubbin="$(mktemp -d)"
printf '#!/bin/sh\nexit 0\n' >"$stubbin/heavy"
chmod +x "$stubbin/heavy"
export PATH="$stubbin:$PATH"
trap 'rm -rf "$stubbin"' EXIT

fail=0

# monta o JSON de input do PreToolUse e roda o hook, devolvendo o stdout
run() {
  local cmd="$1" esc
  esc="$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$esc" | bash "$HOOK" 2>/dev/null
}
is_deny() { grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; }

expect_deny() {
  if run "$1" | is_deny; then echo "  ok    deny   | $1"
  else echo "  FAIL  want deny | $1"; fail=1; fi
}
expect_allow() {
  if run "$1" | is_deny; then echo "  FAIL  want allow | $1"; fail=1
  else echo "  ok    allow  | $1"; fi
}

echo "── pesados sem heavy → deny ──"
expect_deny 'bun run test'
expect_deny 'bun run test src/lib/foo.test.ts'
expect_deny 'cd /tmp/x && bun run test > log 2>&1'
expect_deny 'bunx vitest run src/lib/x'
expect_deny 'bun run typecheck'
expect_deny 'bun run build'
expect_deny 'vite build'
expect_deny 'tsc --noEmit -p tsconfig.app.json'

echo "── já com heavy → allow ──"
expect_allow 'heavy bun run test'
expect_allow 'heavy bun run typecheck'
expect_allow 'cd /tmp/x && heavy bun run test'

echo "── leves / não-pesados → allow ──"
expect_allow 'bun lint'
expect_allow 'bun run lint'
expect_allow 'bun dev'
expect_allow 'git status'
expect_allow 'bun run claude:size'

echo "── leitura/menção (não é execução pesada) → allow ──"
expect_allow 'cat vitest.config.ts'
expect_allow 'grep -r "bun run test" docs/'
expect_allow 'echo "bun run test"'
expect_allow 'git commit -m "fix: bun run build agora passa por heavy"'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
