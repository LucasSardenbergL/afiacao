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

# deny: o guard NÃO conseguiu reescrever e bloqueia. Este caminho é a razão de ser do guard
# (comando pesado que escaparia do semáforo) e não tinha NENHUMA asserção — trocar o
# permissionDecision de "deny" para "allow" sobrevivia à suíte inteira, e o comando pesado
# rodaria sem semáforo. (mutation-check 2026-08-20)
expect_deny() {
  local cmd="$1" out
  out="$(run "$cmd")"
  if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"
      and .hookSpecificOutput.permissionDecision == "deny"
      and ((.hookSpecificOutput.permissionDecisionReason // "") | test("heavy"))' >/dev/null 2>&1
  then echo "  ok    deny   | $cmd"
  else echo "  FAIL  want deny | $cmd → '$out'"; fail=1; fi
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

# allowlist de comandos leves: MENCIONAR um comando pesado não é executá-lo. Sem ela o guard
# reescreveria o texto do echo/da mensagem de commit — a mesma classe do #1778, que enfiou um
# `heavy` dentro do ci.yml. Não havia caso: matar a allowlist inteira sobrevivia à suíte.
# (mutation-check 2026-08-20)
expect_quiet 'echo bun run test'
expect_quiet 'git commit -m documenta o bun run test'
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

echo "── heredoc/aspas: menção ≠ execução (#1770 — o \`heavy\` foi parar no ci.yml) ──"
# Os casos abaixo são multi-linha e sujariam o log das helpers acima (que ecoam o
# comando inteiro) → variantes rotuladas.
expect_quiet_rot() {
  local rot="$1" out
  out="$(run "$2")"
  if [ -z "$out" ]; then echo "  ok    quiet  | $rot"
  else echo "  FAIL  want quiet | $rot → $out"; fail=1; fi
}
expect_rewrite_rot() {
  local rot="$1" cmd="$2" want="$3" out got
  out="$(run "$cmd")"
  got="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // empty' 2>/dev/null)"
  if printf '%s' "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' \
     && [ "$got" = "$want" ]; then
    echo "  ok    rewrite | $rot"
  else
    echo "  FAIL  want rewrite | $rot"
    printf '        esperado: %s\n        obtido:   %s\n' "$want" "${got:-<sem updatedInput>}"; fail=1
  fi
}

# O caso MEDIDO (2026-08-18, PR #1770): uma sessão gravou um step de CI que
# CONTÉM o comando pesado. O guard casou o padrão dentro do heredoc e o
# `.github/workflows/ci.yml` foi gravado com `run: heavy bun run test:hooks`; no
# runner ubuntu o `heavy` não existe (semáforo da M2 local) → 127, `validate`
# VERMELHO. Local passava: o erro só existia no CI.
caso_ci="$(cat <<'CASO'
python3 - <<'PY'
import pathlib
p = pathlib.Path('.github/workflows/ci.yml')
p.write_text(p.read_text() + '      - name: Hooks guard tests\n        run: bun run test:hooks\n')
PY
CASO
)"
expect_quiet_rot 'heredoc python3 que GRAVA o step do CI' "$caso_ci"

# `tee` de propósito: com `cat >`/`printf >` o teste seria TEATRO — o check de
# leitura (nº 4) já barra essas linhas pelo PROGRAMA que as abre e o caso
# passaria mesmo sem sanitização nenhuma. `tee` não está na lista, então só a
# sanitização o segura.
caso_tee="$(cat <<'CASO'
tee /tmp/ci.yml <<'EOF'
  run: bun run test
EOF
CASO
)"
expect_quiet_rot 'heredoc tee (fora da lista de leitura)' "$caso_tee"

caso_tag_nua="$(cat <<'CASO'
tee /tmp/ci.yml <<EOF
  run: bun run typecheck
EOF
CASO
)"
expect_quiet_rot 'heredoc de tag NUA (<<EOF, sem aspas)' "$caso_tag_nua"

caso_aspas="$(cat <<'CASO'
python3 -c 'print("bun run test")'
CASO
)"
expect_quiet_rot 'padrão só dentro de aspas' "$caso_aspas"

# A asserção que impede o "fix" preguiçoso de DESLIGAR o guard quando há
# heredoc: comando MISTO grava o step E roda o teste de verdade. O heredoc sai
# byte a byte igual; só a linha executável recebe o prefixo.
caso_misto="$(cat <<'CASO'
tee /tmp/ci.yml <<'EOF'
  run: bun run test:hooks
EOF
bun run test
CASO
)"
misto_quer="$(cat <<'CASO'
tee /tmp/ci.yml <<'EOF'
  run: bun run test:hooks
EOF
heavy bun run test
CASO
)"
expect_rewrite_rot 'MISTO: grava o step E roda o teste' "$caso_misto" "$misto_quer"

# Espelho do anterior: `heavy` CITADO no heredoc não é o comando passando pelo
# semáforo. Ler o cmd cru no check "já tem heavy" silenciaria o guard e deixaria
# o pesado real da última linha passar NU — falso negativo pelo mesmo motivo.
caso_heavy_citado="$(cat <<'CASO'
tee /tmp/doc.md <<'EOF'
Prefixe com `heavy bun run test` — é o semáforo de RAM.
EOF
bun run test
CASO
)"
heavy_citado_quer="$(cat <<'CASO'
tee /tmp/doc.md <<'EOF'
Prefixe com `heavy bun run test` — é o semáforo de RAM.
EOF
heavy bun run test
CASO
)"
expect_rewrite_rot 'heavy CITADO no heredoc não silencia o guard' \
  "$caso_heavy_citado" "$heavy_citado_quer"

echo "── deny: pesado que o guard NÃO consegue reescrever é BLOQUEADO ──"
# Dentro de crase o casamento acontece (a crase não é sanitizada), mas a reescrita não: ela só
# insere o prefixo depois de ^ ou de [ \t;&|(] — e a crase não está na classe. Sobra rewritten
# == cmd, e aí a única saída correta é negar: deixar passar rodaria o pesado sem semáforo.
# shellcheck disable=SC2016  # a crase TEM de chegar literal ao guard — expandi-la aqui
# executaria `bun run test` de verdade dentro da suíte, que é o oposto do teste.
expect_deny 'resultado=`bun run test`'

echo

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
