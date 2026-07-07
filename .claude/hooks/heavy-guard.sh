#!/usr/bin/env bash
# heavy-guard.sh — PreToolUse(Bash): cadência de RAM na M2 8GB.
#
# Comando PESADO (test/build/typecheck/vitest/tsc) sem `heavy` é REESCRITO
# via updatedInput (permissionDecision=allow) pra passar pelo semáforo `heavy`
# (scripts/heavy.sh), que serializa os pesados entre worktrees/sessões — sem
# round-trip de negação e sem consultar o classificador remoto de permissões.
# Se a reescrita não fechar (caso exótico), NEGA com instrução (comportamento
# antigo, rede de segurança).
#
# Fail-safe (não interfere → exit 0): `heavy` ausente, comando já usa `heavy`,
# comando leve (lint/dev/…), ou linha de leitura/menção (echo/cat/grep/git/…).
# Sem `jq` não há como montar updatedInput com escaping confiável → deny
# instrutivo no caso pesado (nunca allow às cegas). Testes em
# scripts/test-heavy-guard.sh.
set -u

input="$(cat)"

# --- extrai o comando Bash do payload do hook --------------------------------
if command -v jq >/dev/null 2>&1; then
  has_jq=1
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
  has_jq=0
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

deny() {
  reason="RAM na M2 8GB: rode test/build/typecheck pelo semáforo. Prefixe o comando pesado com 'heavy' — ex.: 'heavy bun run test'; em comando composto, 'cd x && heavy bun run test'. O heavy (scripts/heavy.sh) serializa os pesados entre worktrees e não atrasa quando há slot livre. Ver §2 do CLAUDE.md."
  if [ "$has_jq" -eq 1 ]; then
    jq -n --arg r "$reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  else
    esc="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
  fi
  exit 0
}

[ "$has_jq" -eq 1 ] || deny

# --- reescreve: prefixa `heavy ` em cada trecho pesado ------------------------
# Boundary: início da linha, espaço ou ; & | ( — cobre `cd x && bun run test`,
# `VAR=1 bun run test`, `bun run test > log 2>&1`. O check nº 2 garante que o
# comando ainda não contém `heavy`, então não há risco de prefixo duplo.
rewritten="$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:];&|(])($heavy_re)/\\1heavy \\2/g")"

if [ "$rewritten" != "$cmd" ] && printf '%s' "$rewritten" | grep -qE '(^|[[:space:];&|(])heavy[[:space:]]'; then
  printf '%s' "$input" | jq --arg c "$rewritten" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:("heavy-guard: comando pesado reescrito pro semáforo de RAM → " + $c),updatedInput:(.tool_input | .command = $c)}}'
  exit 0
fi

# --- fallback: reescrita não fechou → nega instruindo ------------------------
deny
