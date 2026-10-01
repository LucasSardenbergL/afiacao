#!/usr/bin/env bash
# push-gates-guard.sh — PreToolUse(Bash): roda 3 gates BARATOS do CI antes de um `git push` do
# HEAD atual e NEGA o push quando um deles reprova. O vermelho que o CI leva ~36 min para mostrar
# sai aqui em ~2 s.
#
# Por que existe (medido em 2026-09-26, docs/historico/gates-no-push.md): nos 18 dias anteriores,
# 76% dos runs BLOQUEANTES vermelhos do CI caíram em `gates-e-falsificacao`, e numa amostra de 13
# logs, 6 das 8 falhas mecânicas vinham de três gates que só leem o disco: `docs:indice` (98 ms),
# `docs:citacoes` (2,1 s) e `sonda:fingerprint` (138 ms). O #2565 ficou vermelho por `docs:indice`
# — 40 ms de script — 36 min depois do push.
#
# Contrato (zero falso-positivo no BLOQUEIO, o padrão dos guards deste repo):
#   · só age em `git push` que publica o HEAD atual: sem refspec, só `<remote>`, ou refspec
#     `HEAD`/`<branch-atual>` (com ou sem `+` e `:destino`). Outro alvo (outra branch, tag,
#     --delete, --all, --mirror, --tags, --dry-run, opção que não conheço, alvo entre aspas ou
#     com expansão, GIT_DIR/--git-dir) → não interfere;
#   · os gates leem o DISCO, não o HEAD. Árvore limpa → os dois coincidem e o veredito é o do push
#     → NEGA. Mudança não commitada em arquivo rastreado (inclusive o `git add && git commit &&
#     git push` num comando só, que o hook vê ANTES do commit), ou arquivo novo não rastreado em
#     `docs/` ou `supabase/functions/` → o veredito pode não ser o do push → só AVISA;
#   · reprovação só com EVIDÊNCIA POSITIVA: exit 1 **e** a marca de falha do gate na saída. Gate
#     que não rodou (bun ausente, crash, timeout, marca que mudou de texto) → fail-open: o CI julga;
#   · `--no-verify` é a válvula explícita (a mesma do hook pre-push do git): pula tudo.
#
# Fail-open TOTAL em infra: sem jq/git/bun, fora de um repo com os 3 gates, ou erro → exit 0.
# Roda no bash 3.2 do macOS: sem array associativo, sem `${x,,}`, `${var}` com chave antes de
# não-ASCII (docs/historico/shell-variavel-colada-em-nao-ascii.md).
# Testes: scripts/test-push-gates-guard.sh (o teste também confere que as marcas abaixo ainda
# existem nos fontes dos gates — marca que mudou de texto vira fail-open calado).
set -u

command -v jq  >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0
case "$cmd" in *push*) ;; *) exit 0 ;; esac   # caminho rápido: quase todo Bash sai aqui
case "$cmd" in *GIT_DIR*|*GIT_WORK_TREE*) exit 0 ;; esac   # outro repo por env: não sei julgar

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$cwd" ] || cwd="$PWD"

# Aspas e heredoc viram o token Q: menção a "git push" dentro de string não é execução, e um
# caminho/refspec entre aspas vira um token que nada casa (→ não interfere).
Q='__Q__'
if command -v perl >/dev/null 2>&1; then
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\\s*([\\x27\\x22]?)(\\w+)\\1.*?^\\2[ \\t]*\$/ ${Q} /gms; s/\\x27[^\\x27]*\\x27/ ${Q} /g; s/\\x22[^\\x22]*\\x22/ ${Q} /g" 2>/dev/null)"
else
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'/ ${Q} /g; s/\"[^\"]*\"/ ${Q} /g" 2>/dev/null)"
fi
[ -n "$scan" ] || exit 0

# Um comando simples por linha: quebra em && || ; | & ( ) { } (awk: o `sed` do macOS não
# aceita \n na substituição; classe entre colchetes: escape de `(`/`{` varia entre awks).
segs="$(printf '%s\n' "$scan" | awk '{ gsub(/&&|[|][|]|[;|&(){}]/, "\n"); print }' 2>/dev/null)"
[ -n "$segs" ] || exit 0

# resolver <base> <alvo> → caminho do `cd`/`-C`; falha quando não dá para saber sem executar.
resolver() {
  case "$2" in
    *"$Q"*|*'$'*|*'`'*|-|'') return 1 ;;
    /*) printf '%s' "$2" ;;
    \~) printf '%s' "$HOME" ;;               # o token é o `~` LITERAL (o hook não expande nada)
    \~/*) printf '%s/%s' "$HOME" "${2#??}" ;;
    *) [ -n "$1" ] || return 1; printf '%s/%s' "$1" "$2" ;;
  esac
}

dir="$cwd"; achou_push=""; alvo_dir=""; refspec=""
while IFS= read -r seg; do
  set -f
  # shellcheck disable=SC2086  # tokenizar o segmento É o objetivo (glob desligado acima)
  set -- $seg
  set +f
  while [ $# -gt 0 ]; do case "$1" in do|then|else|'!'|time) shift ;; *) break ;; esac; done
  [ $# -gt 0 ] || continue
  case "$1" in
    cd)
      if [ $# -eq 2 ]; then dir="$(resolver "$dir" "$2")" || dir=""; else dir=""; fi
      continue ;;
    pushd|popd) dir=""; continue ;;
  esac

  # Acha o `git` do segmento (pode vir depois de `env X=y`, `timeout 60`, `command`...).
  tem_git=""
  while [ $# -gt 0 ]; do
    case "$1" in git|*/git) tem_git=1; shift; break ;; esac
    shift
  done
  [ -n "$tem_git" ] || continue
  gdir="$dir"
  while [ $# -gt 0 ]; do
    case "$1" in
      -C) if [ $# -ge 2 ]; then gdir="$(resolver "$gdir" "$2")" || gdir=""; shift 2; else gdir=""; shift; fi ;;
      -c) if [ $# -ge 2 ]; then shift 2; else shift; fi ;;
      --git-dir*|--work-tree*|--namespace*) exit 0 ;;
      -*) shift ;;
      *) break ;;
    esac
  done
  [ "${1:-}" = push ] || continue
  shift

  npos=0; remoto=""
  for a in "$@"; do
    case "$a" in
      --no-verify) exit 0 ;;   # válvula explícita
      -n|--dry-run|-d|--delete|--tags|--all|--branches|--mirror|--prune) exit 0 ;;
      -u|--set-upstream|-f|--force|--force-with-lease|--force-with-lease=*|--force-if-includes|\
      -q|--quiet|-v|--verbose|--progress|--no-progress|--porcelain|--atomic|--no-atomic|\
      --follow-tags|--no-follow-tags|--thin|--no-thin|-4|-6|--ipv4|--ipv6|--no-signed|--signed=*|\
      --recurse-submodules=*|--no-recurse-submodules) ;;
      -*) exit 0 ;;            # opção que não conheço pode mudar o alvo (ex.: --repo=) → não julgo
      *)
        npos=$((npos + 1))
        if [ "$npos" -eq 1 ]; then remoto="$a"; elif [ "$npos" -eq 2 ]; then refspec="$a"; fi ;;
    esac
  done
  [ "$npos" -le 2 ] || exit 0
  case "${remoto}${refspec}" in *"$Q"*|*'$'*|*'`'*) exit 0 ;; esac
  achou_push=1; alvo_dir="$gdir"
  break
done <<EOF
$segs
EOF

[ -n "$achou_push" ] || exit 0
[ -n "$alvo_dir" ] || exit 0

root="$(git -C "$alvo_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$root" ] || exit 0
for f in package.json scripts/docs-indice-gate-check.ts scripts/docs-citacoes-gate-check.ts scripts/sonda-fingerprint.ts; do
  [ -f "$root/$f" ] || exit 0   # outro repo, ou este sem os gates: inerte
done

# O refspec publica o HEAD atual?
if [ -n "$refspec" ]; then
  origem="${refspec#+}"; origem="${origem%%:*}"
  case "$origem" in
    HEAD) ;;
    '') exit 0 ;;               # ":destino" apaga a branch remota
    *)
      branch="$(git -C "$root" branch --show-current 2>/dev/null)"
      [ -n "$branch" ] || exit 0
      [ "$origem" = "$branch" ] || [ "$origem" = "refs/heads/${branch}" ] || exit 0 ;;
  esac
fi

# Árvore limpa? (os gates leem o disco; só com o disco == HEAD o veredito é o do push)
st="$(git -C "$root" status --porcelain --untracked-files=all 2>/dev/null)" || exit 0
sujo=""
while IFS= read -r l; do
  [ -n "$l" ] || continue
  case "$l" in
    '?? docs/'*|'?? "docs/'*|'?? supabase/functions/'*|'?? "supabase/functions/'*) sujo=1 ;;
    '?? '*) ;;                  # não rastreado fora do alcance dos 3 gates: irrelevante
    *) sujo=1 ;;                # rastreado com mudança (staged ou não)
  esac
done <<EOF
$st
EOF

bun_bin="${PGG_BUN:-bun}"
command -v "$bun_bin" >/dev/null 2>&1 || exit 0
limite="${PGG_TIMEOUT:-15}"   # por gate; 3×15 s < 60 s, o timeout padrão de hook do host
tmo_bin=""
if command -v timeout >/dev/null 2>&1; then tmo_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then tmo_bin="gtimeout"
fi

rodar() {  # rodar <script do package.json> → saída (stdout+stderr) e exit do gate
  if [ -n "$tmo_bin" ]; then
    (cd "$root" && "$tmo_bin" "$limite" "$bun_bin" run "$1") 2>&1
  else
    (cd "$root" && "$bun_bin" run "$1") 2>&1
  fi
}

# gate|marca de falha (texto ASCII fixo, caixa fixa — casado sem locale)
reprovados=""; relato=""
for par in 'docs:indice|problema(s)' 'docs:citacoes|quebrada(s)' 'sonda:fingerprint|sonda-fingerprint: o mapa'; do
  nome="${par%%|*}"; marca="${par#*|}"
  saida="$(rodar "$nome")"
  rc=$?
  [ "$rc" -eq 1 ] || continue                           # 0 = passou; outro = não rodou → fail-open
  case "$saida" in *"$marca"*) ;; *) continue ;; esac   # exit 1 sem a marca = crash, não veredito
  reprovados="${reprovados:+${reprovados}, }${nome}"
  relato="${relato}

== bun run ${nome} ==
$(printf '%s' "$saida" | head -c 1500)"
done
[ -n "$reprovados" ] || exit 0

if [ -n "$sujo" ]; then
  msg="⚠️ push-gates-guard: reprovou no DISCO (${reprovados}), mas a árvore tem mudança não commitada ou arquivo novo em docs/ ou supabase/functions/ — o veredito pode não ser o do push, por isso não bloqueei. Se o que vai no push é o que está no disco, o CI vai reprovar igual: conserte e empurre de novo.${relato}"
  jq -n --arg m "$msg" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
  exit 0
fi

motivo="⛔ push-gates-guard: gate do CI reprovando com a árvore limpa (${reprovados}) — este push sairia VERMELHO, e o CI só diria isso uns 30 min depois.${relato}

Conserte, commite e rode o push de novo (localmente: bun run docs:indice · bun run docs:citacoes · bun run sonda:fingerprint). Se o GATE estiver errado, e não o seu diff, git push --no-verify pula esta checagem — e diga isso ao founder."
jq -n --arg r "$motivo" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
