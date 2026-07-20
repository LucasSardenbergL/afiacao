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

# ── instalado mas FORA do PATH ────────────────────────────────────────────────
# O PATH deste hook vem do processo do app, não do perfil de shell — `heavy`
# pode existir em ~/.local/bin e mesmo assim não resolver aqui. A asserção que
# importa não é textual ("saiu o caminho absoluto?") e sim EXECUTÁVEL: o comando
# reescrito tem de RODAR sob o mesmo PATH restrito. Reescrever com o nome nu
# nesse estado devolve 127 (command not found) — o comando pesado simplesmente
# não roda, e o erro não aponta pra causa.
sem_path_home="$(mktemp -d)"
mkdir -p "$sem_path_home/.local/bin"
# stub que ACUSA ter rodado: sem isto, "exit 0" não distingue heavy-executado de
# heavy-inexistente-mas-comando-trivial.
printf '#!/bin/sh\necho HEAVY-RODOU\nexit 0\n' >"$sem_path_home/.local/bin/heavy"
chmod +x "$sem_path_home/.local/bin/heavy"
# PATH sem ~/.local/bin e sem `heavy` algum, mas com o jq de que o hook precisa
sem_path_PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v jq)")"
trap 'rm -rf "$stubbin" "$sem_path_home"' EXIT

expect_invocavel_sem_path() {
  local cmd="$1" out novo saida rc
  out="$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | env HOME="$sem_path_home" PATH="$sem_path_PATH" bash "$HOOK" 2>/dev/null)"
  novo="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null)"
  if [ -z "$novo" ]; then
    echo "  FAIL  fora do PATH: não reescreveu | $cmd"; fail=1; return
  fi
  # roda o comando REESCRITO no mesmo PATH restrito — só o `heavy` precisa
  # resolver, então o resto do comando é trocado por um no-op (`true`).
  saida="$(env HOME="$sem_path_home" PATH="$sem_path_PATH" \
    bash -c "${novo/bun run test/true}" 2>&1)"; rc=$?
  if [ "$rc" -eq 127 ]; then
    echo "  FAIL  fora do PATH: reescrita saiu 127 (heavy não resolve) | $cmd → $novo"; fail=1
  elif [ "$rc" -ne 0 ] || ! printf '%s' "$saida" | grep -q HEAVY-RODOU; then
    echo "  FAIL  fora do PATH: heavy não executou (rc=$rc) | $cmd → $novo"; fail=1
  else
    echo "  ok    invocável fora do PATH | $cmd → $novo"
  fi
}

# heavy AUSENTE de verdade (nem no PATH, nem em ~/.local/bin) → fail-open
expect_quiet_sem_heavy() {
  local out vazio
  vazio="$(mktemp -d)"
  out="$(jq -n --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | env HOME="$vazio" PATH="$sem_path_PATH" bash "$HOOK" 2>/dev/null)"
  rm -rf "$vazio"
  if [ -z "$out" ]; then echo "  ok    fail-open sem heavy | $1"
  else echo "  FAIL  want fail-open sem heavy | $1 → $out"; fail=1; fi
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

echo "── instalado mas FORA do PATH → reescrita tem de ser INVOCÁVEL ──"
expect_invocavel_sem_path 'bun run test'
# composto usa /tmp (que EXISTE): estas asserções EXECUTAM o comando reescrito,
# e um `cd` para diretório inexistente curto-circuitaria o && antes do heavy —
# o teste falharia por rc=1 do cd, mascarando o que ele quer provar.
expect_invocavel_sem_path 'cd /tmp && bun run test'

echo "── heavy realmente ausente → fail-open (não força o que não existe) ──"
expect_quiet_sem_heavy 'bun run test'

echo "── já com heavy por CAMINHO → não interfere (sem prefixo duplo) ──"
expect_quiet "$HOME/.local/bin/heavy bun run test"
expect_quiet './heavy bun run test'

echo "── leitura/menção (não é execução pesada) → não interfere ──"
expect_quiet 'cat vitest.config.ts'
expect_quiet 'grep -r "bun run test" docs/'
expect_quiet 'echo "bun run test"'
expect_quiet 'git commit -m "fix: bun run build agora passa por heavy"'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
