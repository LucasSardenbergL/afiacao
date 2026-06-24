#!/usr/bin/env bash
# destructive-bash-guard.sh — PreToolUse(Bash): trava comando IRREVERSÍVEL do agente sem confirmação.
#
# Defesa contra erro do AGENTE (eu/subagentes), não do founder: o terminal do Lucas NÃO passa por
# este hook; scripts (wt:clean/reap) rodam seus resets INTERNAMENTE, fora do Bash tool, e não são
# vistos. Só o comando que o agente passa ao Bash tool é interceptado.
#
# Pega o que destrói trabalho sem recuperação: git reset --hard, git clean -f, git push --force,
# git branch -D, git checkout -f/--force, git stash clear/drop, e rm -r -f cujos alvos NÃO estão
# todos sob /tmp. Complementa o heavy-guard (que trata `git *` como leitura e ignora).
#
# Detector HEURÍSTICO (não é parser de shell): cobre as formas comuns que o agente escreveria por
# engano. Codex review 2026-06-24 fechou git-global-opts (git -C dir …), rm alvo-misto, variantes
# de flag (-Rf/-r -f/--recursive), confirmação-por-substring, dry-run e pipeline de leitores. É
# prevenção de acidente, não sandbox contra adversário determinado.
#
# Fail-CLOSED na decisão: destrutivo reconhecido → deny. Liberação por CONFIRMAÇÃO EXPLÍCITA como
# env-assignment NO INÍCIO (CONFIRM_DESTRUCTIVE=1 …), exigida sempre — NÃO é bypass-on-retry.
# Fail-open de infra: sem jq, ou erro → exit 0. Testes em scripts/test-destructive-bash-guard.sh.
set -u

command -v jq >/dev/null 2>&1 || exit 0
input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# confirmação explícita SÓ como env-assignment no INÍCIO (não substring solta tipo `echo CONFIRM… &&`)
printf '%s' "$cmd" | grep -qE '^[[:space:]]*CONFIRM_DESTRUCTIVE=(1|true)([[:space:]]|$)' && exit 0

# leitura pura: sem encadeamento real (; && || $() ``), e TODO segmento de pipe começa com leitor → allow
# shellcheck disable=SC2016  # $( e ` são literais do glob (detecção de encadeamento), não expansão
case "$cmd" in
  *';'*|*'&&'*|*'||'*|*'$('*|*'`'*) ;;
  *)
    set -f; _ok=1; _oldifs="$IFS"; IFS='|'
    for _s in $cmd; do
      printf '%s' "$_s" | grep -qE '^[[:space:]]*(echo|printf|grep|rg|cat|head|tail|less|wc|nl|sort|uniq|jq|sed|awk|git[[:space:]]+(status|log|diff|show))([[:space:]]|$)' || _ok=0
    done
    IFS="$_oldifs"; set +f
    [ "$_ok" = 1 ] && exit 0 ;;
esac

# Sanitiza ANTES de detectar: remove heredocs e conteúdo entre aspas (MENÇÃO ≠ execução). Sem isso,
# `git commit <<'MSG' … git reset --hard … MSG` ou `git commit -m "… rm -rf …"` viram falso-positivo
# (o guard chega a bloquear o commit que o documenta). Perde `bash -c "destrutivo"` (raro/deliberado)
# — trade-off correto p/ prevenção-de-acidente. Sem perl → fallback só-strings (heredoc não removido).
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
[ -n "$scan" ] || scan="$cmd"

det() { printf '%s' "$scan" | grep -qE "$1"; }
B='(^|[^[:alnum:]_./-])'
# opções globais do git (zero+) entre `git` e o subcomando: -C dir, -c x=y, --git-dir, --work-tree, etc.
G='git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--git-dir[=[:space:]][^[:space:]]+|--work-tree[=[:space:]][^[:space:]]+|--no-pager|--paginate|-p))*[[:space:]]+'

# rm -r -f cujos operandos NÃO estão todos sob /tmp → destrutivo. Recursão/force lidos só das FLAGS
# (não dos operandos — senão um path tipo `dir-sem-force` dispararia falso-positivo).
rm_destructive() {
  local seg tok safe=1 saw=0 rec=0 frc=0
  seg="$(printf '%s' "$scan" | grep -oE "${B}rm[[:space:]][^;&|]*" | head -1)"
  [ -n "$seg" ] || return 1
  set -f
  seg="${seg#*rm}"
  for tok in $seg; do
    case "$tok" in
      --recursive) rec=1 ;;
      --force) frc=1 ;;
      --*) ;;
      -*) case "$tok" in *[rR]*) rec=1 ;; esac
          case "$tok" in *f*) frc=1 ;; esac ;;
      *) saw=1
         # shellcheck disable=SC2016  # $TMPDIR/${TMPDIR} são literais (path não-expandido do agente)
         case "$tok" in
           /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*|"$TMPDIR"/*|'$TMPDIR'/*|'${TMPDIR}'/*) ;;
           *) safe=0 ;;
         esac ;;
    esac
  done
  set +f
  { [ "$rec" = 1 ] && [ "$frc" = 1 ]; } || return 1   # não é rm recursivo+force
  [ "$saw" = 0 ] && return 0                          # rm -rf sem alvo explícito → destrutivo
  [ "$safe" = 0 ] && return 0
  return 1                                            # todos os alvos sob /tmp → seguro
}

deny=""
if   det "${B}${G}reset[^;&|]*--hard";                                                          then deny="git reset --hard — descarta o working tree (mudanças não-commitadas somem)"
elif det "${B}${G}clean[^;&|]*(-[a-zA-Z]*f|--force)" && ! det "${B}${G}clean[^;&|]*(-[a-zA-Z]*n|--dry-run)"; then deny="git clean -f — apaga arquivos untracked (irrecuperável)"
elif det "${B}${G}push[^;&|]*(--force([^-]|\$)|[[:space:]]-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|\$)|[[:space:]][+][^[:space:]])"; then deny="git push --force — reescreve o remoto (use --force-with-lease se for mesmo preciso)"
elif det "${B}${G}branch[^;&|]*(-[a-zA-Z]*D([[:space:]]|\$)|--delete[^;&|]*--force|--force[^;&|]*--delete)"; then deny="git branch -D — delete forçado de branch (perde commits não-mergeados)"
elif det "${B}${G}checkout[^;&|]*(-f([[:space:]]|\$)|--force)";                                  then deny="git checkout -f/--force — descarta mudanças locais"
elif det "${B}${G}stash[[:space:]][^;&|]*(clear|drop)";                                          then deny="git stash clear/drop — perde o stash"
elif rm_destructive;                                                                             then deny="rm -r -f fora de /tmp — apaga recursivamente sem recuperação"
fi

[ -n "$deny" ] || exit 0

reason="Comando destrutivo irreversível bloqueado: $deny.

Se for INTENCIONAL e confirmado (com o founder, quando o risco é dele), prefixe a confirmação explícita NO INÍCIO do comando:
  CONFIRM_DESTRUCTIVE=1 $cmd
Exigida toda vez — o guard não guarda 'já confirmei antes'. Alternativas seguras: git stash (em vez de reset --hard), git push --force-with-lease (em vez de --force), mover pra /tmp (em vez de rm -rf)."
jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
