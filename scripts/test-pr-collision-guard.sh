#!/usr/bin/env bash
# test-pr-collision-guard.sh — TDD do hook pr-collision-guard.sh (git+gh STUBADOS, sem rede).
#
# Regra (gatilho 1 — `gh pr create`): colisão de arquivos — (a) a origin/main ganhou arquivo que EU
#        também toco desde a merge-base (diff de TRÊS pontos), ou (b) um PR ABERTO de outra
#        branch toca arquivo meu — → AVISA via additionalContext (permissionDecision=allow),
#        SEM bloquear. Sem colisão, comando ≠ `gh pr create`, ou erro de infra → stdout mudo.
#        Fail-open GRANULAR: gh fora → ainda checa a main (git é local).
#
# Regra (gatilho 2 — `git commit`, 2026-08-15): mesma checagem no chokepoint ANTERIOR, porque
#        no create o trabalho JÁ está pronto (evita o merge duplicado, não o desperdício —
#        #1757 e #1764 morreram assim no mesmo dia). No commit o conjunto de arquivos vem de
#        STAGED ∪ working-tree ∪ commits da branch: no PRIMEIRO commit o diff de 3 pontos é
#        VAZIO (o #1764 tinha 1 commit só) e olhar só para ele seria teatro. Anti-alarm-fatigue:
#        avisa UMA vez por (branch, conjunto colidente) — commit é frequente, e aviso repetido
#        cega. Colisão NOVA volta a avisar.
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
      *--cached*)             cat "${GIT_STUB_STAGED_FILE:-/dev/null}" ;;
      *"origin/main...HEAD"*) [ -n "${GIT_STUB_DIFF_FAIL:-}" ] && exit 128; cat "${GIT_STUB_MINE_FILE:-/dev/null}" ;;
      *"HEAD...origin/main"*) cat "${GIT_STUB_GAINED_FILE:-/dev/null}" ;;
      *--name-only)           cat "${GIT_STUB_UNSTAGED_FILE:-/dev/null}" ;;
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
printf 'src/lib/quente.ts\n'  > "$stub/staged_hit.txt"   # staged que COLIDE (caso #1764)
printf 'src/so-meu.ts\n'      > "$stub/staged_miss.txt"
printf 'src/outro.ts\n'       > "$stub/staged_hit2.txt"  # colisao NOVA, para o dedupe nao cegar
printf 'src/outro.ts\n'       > "$stub/gained_hit2.txt"  # ...e a main tem de ter tocado ELE

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

echo '── gatilho 2: git commit (o chokepoint ANTES do trabalho pronto) ──'
# PRIMEIRO commit da branch: diff de 3 pontos VAZIO (mine=/dev/null) — a colisao so aparece
# no STAGED. E exatamente o #1764 (1 commit so). Olhar so o 3-pontos seria teatro.
C="PRCG_CACHE_DIR=$stub/cache1"
expect_warn "commit: staged colide com a main (3-pontos VAZIO — caso #1764)" \
  "$C GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'git commit -m "fix"' 'origin/main' 'src/lib/quente.ts'
expect_warn "commit: staged colide com PR ABERTO de outra branch (caso #1757)" \
  "PRCG_CACHE_DIR=$stub/cache2 GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_miss.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'git commit -am "fix"' '#42' 'src/lib/quente.ts'
expect_quiet "commit: sem colisao" \
  "PRCG_CACHE_DIR=$stub/cache3 GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=$stub/staged_miss.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'git commit -m "x"'
expect_quiet "commit: nada staged nem modificado" \
  "PRCG_CACHE_DIR=$stub/cache4 GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=/dev/null GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_hit.json" \
  'git commit -m "x"'
expect_quiet "commit: mencao entre aspas nao e execucao" \
  "PRCG_CACHE_DIR=$stub/cache5 GIT_STUB_STAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'echo "git commit -m x"'

# working-tree entra so em `-a`: sem ele, arquivo modificado que nao vai no commit e ruido.
expect_quiet "commit sem -a: working-tree colidente NAO conta" \
  "PRCG_CACHE_DIR=$stub/cache6 GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=/dev/null GIT_STUB_UNSTAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'git commit -m "x"'
expect_warn "commit -a: working-tree colidente CONTA" \
  "PRCG_CACHE_DIR=$stub/cache7 GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=/dev/null GIT_STUB_UNSTAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'git commit -am "x"' 'src/lib/quente.ts'

echo "── anti-alarm-fatigue: avisa 1x por (branch, conjunto colidente); colisao NOVA volta a avisar ──"
# 2a chamada IDENTICA fica muda (commit e frequente; repetir o mesmo aviso cega o leitor)...
_hook "$C GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" 'git commit -m "1o"' >/dev/null
expect_quiet "commit: 2a vez com a MESMA colisao → mudo" \
  "$C GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=$stub/staged_hit.txt GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'git commit -m "2o"'
# ...mas colisao em arquivo DIFERENTE e sinal novo: tem de furar o dedupe.
expect_warn "commit: colisao NOVA fura o dedupe" \
  "$C GIT_STUB_MINE_FILE=/dev/null GIT_STUB_STAGED_FILE=$stub/staged_hit2.txt GIT_STUB_GAINED_FILE=$stub/gained_hit2.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'git commit -m "3o"' 'src/outro.ts'
# o dedupe e do COMMIT: o create e o ultimo portao e nunca pode ficar mudo por causa dele.
expect_warn "create NAO herda o silencio do commit (mesmo conjunto)" \
  "$C $M GIT_STUB_GAINED_FILE=$stub/gained_hit.txt GH_STUB_FILE=$stub/prs_miss.json" \
  'gh pr create --fill' 'origin/main' 'src/lib/quente.ts'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
