#!/usr/bin/env bash
# test-pr-collision-guard.sh — TDD do hook pr-collision-guard.sh (git+gh STUBADOS, sem rede).
#
# Regra: `gh pr create` com colisão de arquivos — (a) a origin/main ganhou arquivo que EU
#        também toco desde a merge-base (diff de TRÊS pontos), ou (b) um PR ABERTO de outra
#        branch toca arquivo meu — → AVISA via additionalContext (permissionDecision=allow),
#        SEM bloquear. Sem colisão, comando ≠ `gh pr create`, ou erro de infra → stdout mudo.
#        Fail-open GRANULAR: gh fora → ainda checa a main (git é local).
#
# Uso: bash scripts/test-pr-collision-guard.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/pr-collision-guard.sh"

stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT

# stub de git: fetch é no-op; os DOIS diffs de 3 pontos vêm de arquivos controlados por env
# (origin/main...HEAD = meus arquivos; HEAD...origin/main = o que a main ganhou).
cat >"$stub/git" <<'STUB'
#!/bin/sh
case "$1" in
  fetch)  [ -n "${GIT_STUB_FETCH_FAIL:-}" ] && exit 128; exit 0 ;;
  branch) printf '%s\n' "${GIT_STUB_BRANCH-minha-branch}" ;;
  diff)
    case "$*" in
      *"origin/main...HEAD"*) [ -n "${GIT_STUB_DIFF_FAIL:-}" ] && exit 128; cat "${GIT_STUB_MINE_FILE:-/dev/null}" ;;
      *"HEAD...origin/main"*) cat "${GIT_STUB_GAINED_FILE:-/dev/null}" ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$stub/git"

# stub de gh: JSON de PRs abertos (GH_STUB_FILE) ou falha de rede (GH_STUB_EXIT)
cat >"$stub/gh" <<'STUB'
#!/bin/sh
[ -n "${GH_STUB_EXIT:-}" ] && exit "$GH_STUB_EXIT"
cat "${GH_STUB_FILE:-/dev/null}"
STUB
chmod +x "$stub/gh"

export PATH="$stub:$PATH"

printf 'src/lib/quente.ts\nsrc/outro.ts\n'  > "$stub/mine.txt"
printf 'src/lib/quente.ts\ndocs/alheio.md\n' > "$stub/gained_hit.txt"
printf 'docs/alheio.md\n'                    > "$stub/gained_miss.txt"
printf '%s' '[{"number":42,"title":"toca o helper quente","headRefName":"outra-branch","files":[{"path":"src/lib/quente.ts"},{"path":"src/so-dele.ts"}]}]' > "$stub/prs_hit.json"
printf '%s' '[{"number":43,"title":"nada a ver","headRefName":"outra-branch","files":[{"path":"src/so-dele.ts"}]}]' > "$stub/prs_miss.json"
printf '%s' '[{"number":44,"title":"o MEU proprio PR","headRefName":"minha-branch","files":[{"path":"src/lib/quente.ts"}]}]' > "$stub/prs_own.json"

fail=0

# _hook "<envs de stub>" "<cmd>" → stdout do hook
_hook() {
  local envs="$1" cmd="$2" json
  json="$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
  # shellcheck disable=SC2086  # envs é lista KEY=VAL controlada (valores sem espaço) — split intencional
  printf '%s' "$json" | env $envs bash "$HOOK" 2>/dev/null
}

# expect_warn <nome> <envs> <cmd> <token1> [token2] — allow + additionalContext com os tokens (ASCII, caixa fixa)
expect_warn() {
  local nome="$1" envs="$2" cmd="$3" t1="$4" t2="${5:-}" out ctx
  out="$(_hook "$envs" "$cmd")"
  ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)"
  if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "allow"' >/dev/null 2>&1 \
     && printf '%s' "$ctx" | grep -qF "$t1" \
     && { [ -z "$t2" ] || printf '%s' "$ctx" | grep -qF "$t2"; }; then
    echo "  ok    warn  | $nome"
  else
    echo "  FAIL  want warn ($t1 ${t2:+e $t2}) | $nome | out='$out'"; fail=1
  fi
}

expect_quiet() {  # não interfere: stdout vazio
  local nome="$1" out
  out="$(_hook "$2" "$3")"
  if [ -z "$out" ]; then echo "  ok    quiet | $nome"
  else echo "  FAIL  want quiet | $nome | out='$out'"; fail=1; fi
}

M="GIT_STUB_MINE_FILE=$stub/mine.txt"

echo "── caso-alvo (a): a main ganhou arquivo que EU toco → AVISA ──"
expect_warn "colisao com origin/main" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'gh pr create --title "x" --body "y"' 'origin/main' 'src/lib/quente.ts'

echo "── caso-alvo (b): PR ABERTO de outra branch toca arquivo meu → AVISA ──"
expect_warn "colisao com PR aberto" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_miss.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'gh pr create --fill' '#42' 'src/lib/quente.ts'
expect_warn "gh com flag antes do pr create" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_miss.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'gh --repo x/y pr create --fill' '#42'

echo "── NÃO dispara (sem falso-positivo) ──"
expect_quiet "sem colisao nenhuma" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_miss.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'gh pr create --fill'
expect_quiet "PR aberto e o MEU (mesma branch)" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_miss.txt GH_STUB_FILE=$stub/prs_own.json GIT_STUB_BRANCH=minha-branch" \
  'gh pr create --fill'
expect_quiet "comando nao e pr create" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'gh pr list --state open'
expect_quiet "mencao entre aspas nao e execucao" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'echo "gh pr create --fill"'
expect_quiet "sem diff proprio (mine vazio)" \
  "GIT_STUB_MINE_FILE=/dev/null GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'gh pr create --fill'

echo "── fail-open de infra (granular: nunca trava, nunca chuta) ──"
expect_warn "gh fora MAS main colide → ainda avisa da main" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_EXIT=1" \
  'gh pr create --fill' 'origin/main' 'src/lib/quente.ts'
expect_quiet "gh fora + main sem colisao" \
  "$M GIT_STUB_GAINED_FILE=$stub/gained_miss.txt GH_STUB_EXIT=1" \
  'gh pr create --fill'
expect_warn "fetch falha (offline) → segue com refs locais" \
  "$M GIT_STUB_FETCH_FAIL=1 GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'gh pr create --fill' 'src/lib/quente.ts'
expect_quiet "git diff falha" \
  "GIT_STUB_DIFF_FAIL=1 GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'gh pr create --fill'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
