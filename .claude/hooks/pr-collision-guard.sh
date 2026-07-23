#!/usr/bin/env bash
# pr-collision-guard.sh — PreToolUse(Bash): AVISA (não nega) na hora do `gh pr create` se há
# colisão de arquivos com a origin/main FRESCA ou com PR ABERTO de outra branch.
#
# Automatiza o ritual manual do worktrees.md §"Colisão de CÓDIGO multi-sessão": a checagem de
# `gh pr list` feita no minuto 0 de uma sessão longa é foto velha — o #1526 abriu no minuto em
# que o #1525 mergeou e jogou 26 arquivos fora. A janela de colisão é o tempo da sessão LONGA;
# este hook re-executa a conferência no único instante que importa: imediatamente antes do create.
#
# Interseções por diff de TRÊS pontos (ancora na merge-base — o de dois pontos acusa os próprios
# commits como colisão, falso positivo do #1551):
#   meus arquivos  = git diff --name-only origin/main...HEAD
#   main ganhou    = git diff --name-only HEAD...origin/main
#   colisão (a)    = interseção dos dois;  colisão (b) = meus × files de PRs abertos (gh).
#
# Fail-open TOTAL e GRANULAR: sem jq/git → exit 0; fetch falha → segue com refs locais (stale é
# melhor que nada); gh falha → checa só a main. AVISA via additionalContext com
# permissionDecision=allow — NUNCA bloqueia (re-create legítimo sobre domínio quente existe;
# zero-FP bloqueante é o padrão dos guards deste repo). Testes: scripts/test-pr-collision-guard.sh.
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# É um `gh pr create`? Sanitiza aspas/heredoc antes (menção "gh pr create" ≠ execução).
# shellcheck disable=SC2016  # \x27/\x22 são literais do regex do perl, não expansão de shell
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
[ -n "$scan" ] || scan="$cmd"
printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])gh([[:space:]]+-{1,2}[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+pr[[:space:]]+create([[:space:]]|$)' || exit 0

# Refs frescas — rede pode falhar/pendurar → timeout curto e segue com o que há localmente.
if command -v timeout >/dev/null 2>&1; then
  timeout 8 git fetch origin main --quiet >/dev/null 2>&1 || true
else
  git fetch origin main --quiet >/dev/null 2>&1 || true
fi

# Meus arquivos desde a merge-base (3 pontos, HEAD por último). Sem diff próprio → nada a colidir.
mine="$(git diff --name-only origin/main...HEAD 2>/dev/null)" || exit 0
[ -n "$mine" ] || exit 0
mine_sorted="$(printf '%s\n' "$mine" | sort -u)"

avisos=""

# (a) A main ganhou arquivo que EU também toco?
ganhou="$(git diff --name-only HEAD...origin/main 2>/dev/null)" || ganhou=""
if [ -n "$ganhou" ]; then
  col_main="$(comm -12 <(printf '%s\n' "$mine_sorted") <(printf '%s\n' "$ganhou" | sort -u) 2>/dev/null | head -12)"
  if [ -n "$col_main" ]; then
    avisos="A origin/main GANHOU commits nesses arquivos que você também toca (desde a merge-base):
$col_main
Confira se o seu diff ainda vale antes de criar o PR — pode já ter sido feito/suplantado (padrão #1525/#1526)."
  fi
fi

# (b) PR ABERTO de OUTRA branch tocando arquivo meu? (gh é rede → fail-open granular: pula se falhar)
if command -v gh >/dev/null 2>&1; then
  branch="$(git branch --show-current 2>/dev/null)" || branch=""
  prs="$(gh pr list --state open --json number,title,headRefName,files --limit 30 2>/dev/null)" || prs=""
  if [ -n "$prs" ]; then
    col_prs="$(printf '%s' "$prs" | jq -r --arg mine "$mine_sorted" --arg me "$branch" '
      ($mine | split("\n") | map(select(length > 0))) as $m
      | .[]
      | select(.headRefName != $me)
      | [.files[].path] as $paths
      | ($paths - ($paths - $m)) as $hit
      | select(($hit | length) > 0)
      | "  PR #\(.number) (\(.title)) ja toca: \($hit | join(", "))"' 2>/dev/null | head -8)"
    if [ -n "$col_prs" ]; then
      avisos="$avisos${avisos:+

}PR(s) ABERTO(s) de outra sessao tocando arquivo(s) que este PR tambem toca:
$col_prs"
    fi
  fi
fi

[ -n "$avisos" ] || exit 0

msg="⚠️ Colisão multi-sessão detectada na hora do gh pr create (re-conferência automática — worktrees.md §Colisão de CÓDIGO).
$avisos

Antes de criar: se o núcleo já mergeou/está em voo, fechar > reconciliar — salve só o SEU diferencial num PR enxuto sobre o vencedor. Para inspecionar: gh pr list --search \"<domínio>\" e git log origin/main -- <arquivo>."
jq -n --arg m "$msg" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
exit 0
