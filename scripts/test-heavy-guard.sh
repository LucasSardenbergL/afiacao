#!/usr/bin/env bash
# test-heavy-guard.sh — TDD do hook .claude/hooks/heavy-guard.sh
#
# Regra: comando PESADO (test/build/typecheck/vitest/tsc) SEM `heavy` →
#        REESCRITO (allow + updatedInput com `heavy ` prefixado).
#        Já com `heavy`, ou leve, ou leitura/menção → não interfere (stdout mudo).
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
  jq -n --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c,description:"t",timeout:9}}' \
    | bash "$HOOK" 2>/dev/null
}

# reescrita: allow + updatedInput.command exatamente igual ao esperado
expect_rewrite() {
  local cmd="$1" want="$2" out got
  out="$(run "$cmd")"
  got="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null)"
  if printf '%s' "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' \
     && [ "$got" = "$want" ]; then
    echo "  ok    rewrite | $cmd → $got"
  else
    echo "  FAIL  want rewrite '$want' | $cmd → '${got:-<sem updatedInput>}'"; fail=1
  fi
}

# updatedInput preserva os demais campos do tool_input (description/timeout)
expect_preserva_campos() {
  local out
  out="$(run 'bun run test')"
  if [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.description')" = "t" ] \
     && [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.timeout')" = "9" ]; then
    echo "  ok    updatedInput preserva description/timeout"
  else
    echo "  FAIL  updatedInput perdeu campos do tool_input"; fail=1
  fi
}

# não interfere: stdout vazio (sem decisão)
expect_quiet() {
  local out
  out="$(run "$1")"
  if [ -z "$out" ]; then echo "  ok    quiet  | $1"
  else echo "  FAIL  want quiet | $1 → $out"; fail=1; fi
}

echo "── pesados sem heavy → reescrita (allow + updatedInput) ──"
expect_rewrite 'bun run test'                          'heavy bun run test'
expect_rewrite 'bun run test src/lib/foo.test.ts'      'heavy bun run test src/lib/foo.test.ts'
expect_rewrite 'cd /tmp/x && bun run test > log 2>&1'  'cd /tmp/x && heavy bun run test > log 2>&1'
expect_rewrite 'bunx vitest run src/lib/x'             'heavy bunx vitest run src/lib/x'
expect_rewrite 'bun run typecheck'                     'heavy bun run typecheck'
expect_rewrite 'bun run build'                         'heavy bun run build'
expect_rewrite 'vite build'                            'heavy vite build'
expect_rewrite 'tsc --noEmit -p tsconfig.app.json'     'heavy tsc --noEmit -p tsconfig.app.json'
expect_rewrite 'bun run typecheck && bun run test'     'heavy bun run typecheck && heavy bun run test'
expect_rewrite 'VITEST_MAX_THREADS=1 bun run test'     'VITEST_MAX_THREADS=1 heavy bun run test'
expect_preserva_campos

echo "── já com heavy → não interfere ──"
expect_quiet 'heavy bun run test'
expect_quiet 'heavy bun run typecheck'
expect_quiet 'cd /tmp/x && heavy bun run test'

echo "── leves / não-pesados → não interfere ──"
expect_quiet 'bun lint'
expect_quiet 'bun run lint'
expect_quiet 'bun dev'
expect_quiet 'git status'
expect_quiet 'bun run claude:size'

echo "── leitura/menção (não é execução pesada) → não interfere ──"
expect_quiet 'cat vitest.config.ts'
expect_quiet 'grep -r "bun run test" docs/'
expect_quiet 'echo "bun run test"'
expect_quiet 'git commit -m "fix: bun run build agora passa por heavy"'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
