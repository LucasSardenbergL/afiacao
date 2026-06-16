#!/usr/bin/env bash
# heavy-guard.sh — PreToolUse(Bash): cadência de RAM na M2 8GB.
#
# Força test/build/typecheck a passarem pelo semáforo `heavy` (scripts/heavy.sh),
# que serializa os pesados entre worktrees/sessões pra não saturar a RAM. Um
# comando PESADO sem `heavy` é NEGADO com instrução; o agente re-roda com `heavy`
# (que não atrasa quando há slot livre, então não há custo no caso ocioso).
#
# Fail-safe (não interfere → exit 0): `heavy` ausente, comando já usa `heavy`,
# comando leve (lint/dev/…), ou linha de leitura/menção (echo/cat/grep/git/…).
#
# Negação (formato PreToolUse atual): exit 0 + JSON com
# hookSpecificOutput.permissionDecision="deny". Testes em scripts/test-heavy-guard.sh.
set -u

input="$(cat)"

# --- extrai o comando Bash do payload do hook --------------------------------
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
  cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
fi
[ -n "$cmd" ] || exit 0

# --- fail-safes que NÃO interferem (exit 0) ----------------------------------
# 1) `heavy` indisponível → não força o que não existe
command -v heavy >/dev/null 2>&1 || [ -x "$HOME/.local/bin/heavy" ] || exit 0

# 2) comando já passa pelo heavy
printf '%s' "$cmd" | grep -qE '(^|[[:space:];&|()])heavy[[:space:]]' && exit 0

# 3) linha de leitura/menção — nunca é execução pesada de verdade
case "$cmd" in
  echo\ * | printf\ * | cat\ * | grep\ * | rg\ * | ls\ * | head\ * | tail\ * | sed\ * | awk\ * | git\ * | \#*)
    exit 0 ;;
esac

# --- detecta comando pesado (test/build/typecheck/vitest/tsc) ----------------
heavy_re='(bun run (test|build|typecheck)|bunx? +vitest|vitest +run|vite +build|bun +build|tsc +[^|]*--noEmit)'
printf '%s' "$cmd" | grep -qE "$heavy_re" || exit 0

# --- nega, instruindo a usar heavy -------------------------------------------
reason="RAM na M2 8GB: rode test/build/typecheck pelo semáforo. Prefixe o comando pesado com 'heavy' — ex.: 'heavy bun run test'; em comando composto, 'cd x && heavy bun run test'. O heavy (scripts/heavy.sh) serializa os pesados entre worktrees e não atrasa quando há slot livre. Ver §2 do CLAUDE.md."
if command -v jq >/dev/null 2>&1; then
  jq -n --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
else
  esc="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
fi
exit 0
