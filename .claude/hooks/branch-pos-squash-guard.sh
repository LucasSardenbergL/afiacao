#!/usr/bin/env bash
# branch-pos-squash-guard.sh — PreToolUse(Bash): AVISA (não nega) antes de recommitar
# numa branch cuja fatia JÁ foi squash-mergeada na origin/main.
#
# Armadilha recorrente (mordeu 2× na própria sessão do diagnóstico 2026-07): depois que
# o auto-merge faz SQUASH do PR, a origin/main ganha 1 commit novo que NÃO é ancestral dos
# commits locais da branch. Continuar commitando/amendando ali recria trabalho já mergeado.
#
# Heurística de baixo falso-positivo (só 🔴 avisa): (1) o comando é `git commit`/`--amend`;
# (2) a branch não é main/master; (3) há commits locais fora de origin/main
# (`git rev-list origin/main..HEAD` > 0 — barato/local, e evita o gh na maioria dos commits);
# (4) o PR dessa branch já está MERGED (`gh pr list --head <branch> --state merged`). Só quando
# TUDO bate. AVISA via additionalContext (o modelo lê e reconsidera) com permissionDecision=allow
# — NUNCA bloqueia (zero-FP é o padrão dos guards deste repo; recommit legítimo pós-merge existe).
#
# gh é rede → resultado cacheado por (repo, branch) com TTL curto (BSG_CACHE_TTL=120s) para não
# custar em todo commit. Fail-open TOTAL: sem jq/git/gh, gh/rev-list falhando, ou qualquer erro
# → exit 0 (nunca trava, nunca chuta um aviso). Testes em scripts/test-branch-pos-squash-guard.sh.
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# É um `git commit`? Sanitiza aspas/heredoc antes (menção "git commit" ≠ execução).
# shellcheck disable=SC2016  # \x27/\x22 são literais do regex do perl, não expansão de shell
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
[ -n "$scan" ] || scan="$cmd"
printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_./-])git([[:space:]]+-{1,2}[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)' || exit 0

# Branch atual — vazio (detached) ou main/master → nada a avisar.
branch="$(git branch --show-current 2>/dev/null)" || exit 0
[ -n "$branch" ] || exit 0
case "$branch" in main|master) exit 0 ;; esac

# Há commits locais fora de origin/main? (barato/local; poupa o gh na maioria dos casos)
n="$(git rev-list --count origin/main..HEAD 2>/dev/null)" || exit 0
[ -n "$n" ] || exit 0
[ "$n" -gt 0 ] 2>/dev/null || exit 0

# O PR dessa branch já foi MERGED? (rede → cache curto por repo+branch)
command -v gh >/dev/null 2>&1 || exit 0
cache_dir="${BSG_CACHE_DIR:-${TMPDIR:-/tmp}/afiacao-bsg-cache}"
ttl="${BSG_CACHE_TTL:-120}"
root="$(git rev-parse --show-toplevel 2>/dev/null)"; [ -n "$root" ] || root="."
key="$(printf '%s' "$root:$branch" | (shasum 2>/dev/null || cksum) | cut -c1-16)"
cache_file="$cache_dir/$key"

verdict=""
if [ "$ttl" -gt 0 ] 2>/dev/null && [ -f "$cache_file" ]; then
  mtime="$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || printf 0)"
  now="$(date +%s)"
  [ "$(( now - mtime ))" -lt "$ttl" ] && verdict="$(cat "$cache_file" 2>/dev/null)"
fi

if [ -z "$verdict" ]; then
  merged_n="$(gh pr list --head "$branch" --state merged --json number --limit 1 2>/dev/null | jq 'length' 2>/dev/null)"
  [ -n "$merged_n" ] || exit 0   # gh falhou/rede fora → fail-open (não avisa, não cacheia)
  if [ "$merged_n" -gt 0 ] 2>/dev/null; then verdict="merged"; else verdict="clean"; fi
  mkdir -p "$cache_dir" 2>/dev/null && printf '%s' "$verdict" > "$cache_file" 2>/dev/null
fi

[ "$verdict" = "merged" ] || exit 0

# 🔴 AVISA sem bloquear — permissionDecision=allow + additionalContext (o modelo lê e reconsidera).
msg="⚠️ Squash pós-merge: a branch '$branch' já tem PR MERGED na origin/main, mas ainda há commits locais fora dela (o squash não os tornou ancestrais). Recommitar/amendar aqui pode recriar trabalho já mergeado — a armadilha recorrente. Confirme se é intencional; o padrão é abrir uma branch/worktree NOVO pro follow-up (docs/agent/worktrees.md)."
jq -n --arg m "$msg" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
exit 0
