#!/usr/bin/env bash
# test-destructive-bash-guard.sh — TDD do hook .claude/hooks/destructive-bash-guard.sh
#
# Regra: comando irreversível (git reset --hard, clean -f, push --force, branch -D, checkout -f,
# stash drop/clear, rm -r -f fora de /tmp) → deny. CONFIRM_DESTRUCTIVE=1 no início, comando seguro,
# dry-run, ou menção/leitura pura → allow. Cobre as variações do Codex review 2026-06-24.
#
# Uso: bash scripts/test-destructive-bash-guard.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/destructive-bash-guard.sh"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }

run() { # <command> → stdout do hook
  local enc
  enc="$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$enc" | bash "$HOOK" 2>/dev/null
}
is_deny() { grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; }
fail=0
d() { if run "$1" | is_deny; then echo "  ok    deny  | $1"; else echo "  FAIL  want deny  | $1"; fail=1; fi; }
a() { if run "$1" | is_deny; then echo "  FAIL  want allow | $1"; fail=1; else echo "  ok    allow | $1"; fi; }

echo "── destrutivo → deny (inclui variantes do Codex) ──"
d 'git reset --hard'
d 'git reset --hard HEAD~3'
d 'git reset -q --hard'
d 'git -C /tmp/outro/repo reset --hard'
d 'git --git-dir=.git --work-tree=. reset --hard'
d 'git -c advice.detachedHead=false checkout -f'
d 'git clean -fd'
d 'git clean -d -f'
d 'git clean --force -d'
d 'git push --force'
d 'git push origin main -f'
d 'git push origin +main'
d 'git push -uf origin main'
d 'git branch -D feature/x'
d 'git branch --delete --force feature/x'
d 'git checkout -f'
d 'git checkout --force main'
d 'git stash drop'
d 'git stash --quiet drop stash@{0}'
d 'git stash clear'
d 'rm -rf /Users/lucas/repo/src'
d 'rm -r -f /Users/lucas/repo'
d 'rm -Rf /Users/lucas/repo'
d 'rm --recursive --force /Users/lucas/repo'
d 'rm -rf /tmp/foo /Users/lucas/repo'
d 'rm -rf /tmp/foo .'
d 'rm -rf ~/Documentos'
d 'echo iniciando && git reset --hard'
d 'echo CONFIRM_DESTRUCTIVE=1 && git reset --hard'
d 'cd /tmp && git clean -fdx'

echo "── seguro / dry-run / leitura → allow ──"
a 'git status'
a 'git reset --soft HEAD~1'
a 'git reset HEAD arquivo.ts'
a 'git push'
a 'git push origin main'
a 'git push --force-with-lease'
a 'git checkout main'
a 'git checkout -b nova-branch'
a 'git branch -d ja-mergeada'
a 'git clean -n'
a 'git clean -fdn'
a 'git stash'
a 'git stash pop'
a 'rm -rf /tmp/ecc-analysis'
a 'rm -rf /tmp/foo /private/var/folders/x'
a 'rm arquivo.txt'
a 'rm -r dir-sem-force'
a 'mygit reset --hard'
a 'grep "rm -rf" Makefile'
a 'rg "git reset --hard" . | head'
a 'grep -R "rm -rf" . | head'
a 'CONFIRM_DESTRUCTIVE=1 git reset --hard'

echo "── menção (string/heredoc) ≠ execução → allow ──"
a 'git commit -m "doc: git reset --hard e rm -rf no guard"'
a "$(printf 'git commit -F - <<EOF\nfecha git push --force, rm -rf e git reset --hard\nEOF\n')"

echo
if [ "$fail" -eq 0 ]; then echo "PASS — destructive-bash-guard"; else echo "FALHOU ($fail)"; fi
exit "$fail"
