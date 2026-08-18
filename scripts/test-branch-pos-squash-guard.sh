#!/usr/bin/env bash
# test-branch-pos-squash-guard.sh — TDD do hook branch-pos-squash-guard.sh (git+gh STUBADOS, sem rede).
#
# Regra: `git commit`/`--amend` numa branch com commits locais fora de origin/main
#        (rev-list origin/main..HEAD > 0) cujo PR já está MERGED (gh) → AVISA via
#        additionalContext (permissionDecision=allow), SEM bloquear. Qualquer outra
#        combinação, ou erro de infra (gh/rev-list falham) → NÃO interfere (stdout mudo).
#
# Uso: bash scripts/test-branch-pos-squash-guard.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/branch-pos-squash-guard.sh"

stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT

# stub de git: branch (git branch --show-current) e rev-list controlados por env
cat >"$stub/git" <<'STUB'
#!/bin/sh
case "$1" in
  branch)   printf '%s\n' "${GIT_STUB_BRANCH-main}" ;;
  rev-list) [ -n "${GIT_STUB_REVLIST_FAIL:-}" ] && exit 128; printf '%s\n' "${GIT_STUB_REVCOUNT:-0}" ;;
  *)        exit 0 ;;   # rev-parse etc → vazio/ok
esac
STUB
chmod +x "$stub/git"

# stub de gh: array JSON de PRs merged (GH_STUB_FILE) ou falha de rede (GH_STUB_EXIT)
cat >"$stub/gh" <<'STUB'
#!/bin/sh
[ -n "${GH_STUB_EXIT:-}" ] && exit "$GH_STUB_EXIT"
cat "${GH_STUB_FILE:-/dev/null}"
STUB
chmod +x "$stub/gh"

export PATH="$stub:$PATH"
printf '%s' '[{"number":1217}]' > "$stub/merged.json"
printf '%s' '[]'               > "$stub/naomerged.json"

fail=0

# _hook "<envs de stub>" "<cmd>" → stdout do hook
_hook() {
  local envs="$1" cmd="$2" json
  json="$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
  # shellcheck disable=SC2086  # envs é lista KEY=VAL controlada (valores sem espaço) — split intencional
  printf '%s' "$json" | env BSG_CACHE_TTL=0 $envs bash "$HOOK" 2>/dev/null
}

expect_warn() {  # dispara: allow + additionalContext mencionando 'squash'
  local nome="$1" out ctx
  out="$(_hook "$2" "$3")"
  ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)"
  if printf '%s' "$out" | grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' \
     && printf '%s' "$ctx" | grep -qi 'squash'; then
    echo "  ok    warn  | $nome"
  else
    echo "  FAIL  want warn | $nome | out='$out'"; fail=1
  fi
}

expect_quiet() {  # não interfere: stdout vazio
  local nome="$1" out
  out="$(_hook "$2" "$3")"
  if [ -z "$out" ]; then echo "  ok    quiet | $nome"
  else echo "  FAIL  want quiet | $nome | out='$out'"; fail=1; fi
}

echo "── caso-alvo: branch pós-squash + git commit → AVISA ──"
expect_warn "commit em branch merged"        'GIT_STUB_BRANCH=feature-x GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'git commit -m "wip"'
expect_warn "commit --amend em branch merged" 'GIT_STUB_BRANCH=feature-x GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'git commit --amend --no-edit'
expect_warn "cd && git commit"                'GIT_STUB_BRANCH=feature-x GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'cd /x && git commit -m y'

echo "── NÃO dispara (sem falso-positivo) ──"
expect_quiet "PR ainda não mergeado"          'GIT_STUB_BRANCH=feature-y GIT_STUB_REVCOUNT=2 GH_STUB_FILE='"$stub"'/naomerged.json' 'git commit -m "wip"'
expect_quiet "sem commits locais (rev-list 0)" 'GIT_STUB_BRANCH=feature-z GIT_STUB_REVCOUNT=0 GH_STUB_FILE='"$stub"'/merged.json' 'git commit -m "wip"'
expect_quiet "na própria main"                'GIT_STUB_BRANCH=main GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'git commit -m "wip"'
expect_quiet "detached HEAD (branch vazio)"   'GIT_STUB_BRANCH= GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'git commit -m "wip"'
expect_quiet "comando não é commit"           'GIT_STUB_BRANCH=feature-x GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'git status'
expect_quiet "menção entre aspas ≠ commit"    'GIT_STUB_BRANCH=feature-x GIT_STUB_REVCOUNT=3 GH_STUB_FILE='"$stub"'/merged.json' 'echo "git commit -m x"'

echo "── fail-open de infra (nunca trava, nunca chuta) ──"
expect_quiet "gh falha (rede fora)"           'GIT_STUB_BRANCH=feature-x GIT_STUB_REVCOUNT=3 GH_STUB_EXIT=1' 'git commit -m "wip"'
expect_quiet "rev-list falha (origin/main ausente)" 'GIT_STUB_BRANCH=feature-x GIT_STUB_REVLIST_FAIL=1 GH_STUB_FILE='"$stub"'/merged.json' 'git commit -m "wip"'

echo "── cache (não custar gh em todo commit) ──"
# 1ª chamada (TTL>0) grava 'merged'; 2ª com gh QUEBRADO ainda avisa → provou o cache HIT
cachedir="$stub/cache-hit"
out1="$(printf '%s' "$(jq -n '{tool_name:"Bash",tool_input:{command:"git commit -m z"}}')" \
  | env GIT_STUB_BRANCH=feature-cache GIT_STUB_REVCOUNT=3 GH_STUB_FILE="$stub/merged.json" \
        BSG_CACHE_DIR="$cachedir" BSG_CACHE_TTL=120 bash "$HOOK" 2>/dev/null)"
out2="$(printf '%s' "$(jq -n '{tool_name:"Bash",tool_input:{command:"git commit -m z"}}')" \
  | env GIT_STUB_BRANCH=feature-cache GIT_STUB_REVCOUNT=3 GH_STUB_EXIT=1 \
        BSG_CACHE_DIR="$cachedir" BSG_CACHE_TTL=120 bash "$HOOK" 2>/dev/null)"
if printf '%s' "$out1" | grep -qi 'squash' && printf '%s' "$out2" | grep -qi 'squash'; then
  echo "  ok    cache HIT: 2ª chamada avisa mesmo com gh quebrado"
else
  echo "  FAIL  cache não segurou o veredito | out1='$out1' out2='$out2'"; fail=1
fi

# O cache le mtime via `stat`, cujo contrato DIVERGE entre BSD (macOS, do founder) e GNU (Linux,
# do CI): no GNU `stat -f %m` NAO falha (-f = --file-system), entao um `a || b` cai no primeiro e
# devolve lixo — cache eternamente "expirado". Verde num ambiente NAO prova (licao do #1483):
# aqui os DOIS contratos sao exercitados por stub.
echo "── portabilidade do stat: cache HIT nos DOIS contratos (BSD e GNU) ──"
_cache_hit_com_stat() {   # $1=nome  $2=corpo do stub de stat
  local nome="$1" corpo="$2" d="$stub/statbox-$1" o1 o2
  mkdir -p "$d"; printf '%s\n' '#!/bin/sh' "$corpo" > "$d/stat"; chmod +x "$d/stat"
  local cd2="$stub/cache-$1"
  o1="$(printf '%s' "$(jq -n '{tool_name:"Bash",tool_input:{command:"git commit -m z"}}')" \
    | env PATH="$d:$PATH" GIT_STUB_BRANCH=feature-cache GIT_STUB_REVCOUNT=3 \
          GH_STUB_FILE="$stub/merged.json" BSG_CACHE_DIR="$cd2" BSG_CACHE_TTL=120 bash "$HOOK" 2>/dev/null)"
  o2="$(printf '%s' "$(jq -n '{tool_name:"Bash",tool_input:{command:"git commit -m z"}}')" \
    | env PATH="$d:$PATH" GIT_STUB_BRANCH=feature-cache GIT_STUB_REVCOUNT=3 GH_STUB_EXIT=1 \
          BSG_CACHE_DIR="$cd2" BSG_CACHE_TTL=120 bash "$HOOK" 2>/dev/null)"
  if printf '%s' "$o1" | grep -qi 'squash' && printf '%s' "$o2" | grep -qi 'squash'; then
    echo "  ok    cache HIT sob stat $nome"
  else
    echo "  FAIL  cache nao segurou sob stat $nome | o2='$o2'"; fail=1
  fi
}
# GNU: -c %Y devolve epoch; -f %m SAI 0 com lixo (o exato comportamento que cegou o cache).
# shellcheck disable=SC2016  # o corpo do stub e literal: $1/$2 sao do stub, nao desta shell
_cache_hit_com_stat gnu 'case "$1" in
  -c) [ "$2" = "%Y" ] && { date +%s; exit 0; }; exit 1 ;;
  -f) echo "Blocks: 123 Size: 456"; exit 0 ;;
esac
exit 1'
# BSD: -c nao existe (falha); -f %m devolve epoch.
# shellcheck disable=SC2016  # idem
_cache_hit_com_stat bsd 'case "$1" in
  -c) echo "stat: illegal option -- c" >&2; exit 1 ;;
  -f) [ "$2" = "%m" ] && { date +%s; exit 0; }; exit 1 ;;
esac
exit 1'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
