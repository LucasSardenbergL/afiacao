#!/usr/bin/env bash
# wt-clean.sh — apaga o node_modules de worktrees PARADOS.
#
# Cada worktree do Afiação tem seu próprio node_modules (~580 MB pela conta do
# `du`). Este comando varre TODOS os worktrees e apaga o node_modules dos que
# estão parados — sem destruir nada: pra voltar a usar é só `bun install`.
# O que ele devolve é DISCO, e bem menos do que o `du` sugere (regra 3). RAM ele
# não devolve: memória presa mora em processo (`wt:reap`), não em node_modules.
#
# SEGURANÇA (desenhada com o codex):
#   - pula o worktree ATUAL (a sessão que você está usando agora);
#   - pula worktree com sessão/processo VIVO (claude/bun/node/vite/tsx/vitest com
#     o cwd lá dentro), detectado via lsof — não apaga debaixo de quem trabalha;
#   - re-checa atividade imediatamente antes de apagar (fecha a corrida com um
#     `bun install` que começou no meio) e faz rename atômico antes do rm;
#   - pula worktree `locked` (o lock é intenção humana de preservar);
#   - pula node_modules que é symlink (não é cópia descartável).
#
# ⚠️ Este script APAGA. Três regras, todas travadas por `scripts/test-wt-clean.sh`
# (as duas primeiras vieram do #1838 e da varredura dos irmãos):
#
#   1. Sonda de segurança AUSENTE é fail-CLOSED, não "sem medida". Medido: com
#      `lsof` devolvendo 127 (não-macOS, ou PATH capado), `active_file` fica
#      vazio, `is_active` passa a responder "não" para TODO mundo e a worktree
#      de sessão viva vira candidata a ter o node_modules apagado — sem uma
#      palavra sobre a sonda ter faltado. Diferente do `wt:status`, que só lê,
#      aqui a leitura que falta vira destruição: sem `lsof` o `--yes` ABORTA.
#   2. `sz="$(du -sm "$nm" | cut -f1)"` sob `set -e`+`pipefail`, fora de contexto
#      de teste, MATA o script quando o `du` falha (medido: EXIT=1, varredura
#      parando na 1ª worktree) — o `${sz:-0}` da linha seguinte, que declarava a
#      intenção de degradar, nunca chegava a rodar. E o `du` não tinha teto:
#      node_modules em máquina saturada custa 6-8s cada. Agora tem teto e quem
#      não foi medido entra como "sem medida", nunca como 0 MB.
#   3. A soma de `du` é tamanho APARENTE, não disco a recuperar. O bun instala
#      por clone do cache global (`clonefile`, o default no macOS) e o `du` conta
#      em cada worktree os blocos que elas dividem. Medido em 2026-11-17: o
#      dry-run prometia ~77605 MB em 121 worktrees, o founder autorizou por esse
#      número, e o disco livre subiu 1923 MB. Por isso o relatório diz
#      "APARENTES", e o `--yes` mede o `df` antes e depois e imprime o ganho de
#      verdade. `df` que não responde vira "sem medida", nunca 0 MB.
#
# Uso:
#   bun run wt:clean                          # DRY-RUN: só mostra o que faria
#   bun run wt:clean --yes                    # executa de verdade
#   bun run wt:clean --yes --include-current  # inclui o worktree atual
#                                             # (use ao FECHAR a sessão dele)
set -euo pipefail

YES=0
INCLUDE_CURRENT=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) YES=1 ;;
    --include-current) INCLUDE_CURRENT=1 ;;
    -h | --help)
      sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "argumento desconhecido: $arg" >&2
      exit 2
      ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/wt-medida.sh disable=SC1091
. "$here/lib/wt-medida.sh"

rp() { realpath "$1" 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }

self="$(rp "$PWD")"

# --- diretórios com processo vivo (cwd dentro) ------------------------------
# Sem `lsof` não há como saber quem está trabalhando. Não dá para "degradar": o
# efeito colateral é apagar node_modules debaixo de uma sessão viva.
if ! sonda_lsof_ok; then
  if [ "$YES" -eq 1 ]; then
    echo "❌ lsof não respondeu (ausente ou quebrado) — sem ele não sei quais worktrees têm" >&2
    echo "   sessão viva, e apagar às cegas pode derrubar node_modules de quem está trabalhando. Abortando." >&2
    exit 1
  fi
  SONDA_ATIVIDADE=0
else
  SONDA_ATIVIDADE=1
fi

active_file="$(mktemp)"
trap 'rm -f "$active_file"' EXIT
{
  for proc in claude bun node vite tsx vitest esbuild npm; do
    lsof -nP -a -c "$proc" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  done
} | while IFS= read -r d; do
  [ -n "$d" ] || continue
  rp "$d"
done | sort -u >"$active_file" 2>/dev/null || true

is_active() {
  # ativo se algum processo tem cwd igual ao worktree OU dentro dele
  local wt="$1" d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ "$d" = "$wt" ] && return 0
    case "$d/" in "$wt"/*) return 0 ;; esac
  done <"$active_file"
  return 1
}

# --- varre os worktrees -----------------------------------------------------
freed=0
planned=0
sem_medida=0
cur_wt=""
cur_locked=0

# --- disco livre ANTES (regra 3) --------------------------------------------
# Só o --yes mede: é o único modo que muda o disco. O dry-run não tem o que
# comparar, e estimar o ganho a partir do `du` é exatamente o defeito da regra 3.
livre_antes=""
livre_depois=""
if [ "$YES" -eq 1 ]; then
  livre_antes="$(df_livre_mb "$self")" || livre_antes=""
fi

flush() {
  [ -n "$cur_wt" ] || return 0
  local wt nm reason="" sz rc trash
  wt="$(rp "$cur_wt")"
  nm="$wt/node_modules"

  if [ "$wt" = "$self" ] && [ "$INCLUDE_CURRENT" -eq 0 ]; then
    reason="atual"
  elif [ "$cur_locked" -eq 1 ]; then
    reason="locked"
  elif [ ! -e "$nm" ]; then
    reason="sem node_modules"
  elif [ -L "$nm" ]; then
    reason="symlink"
  elif is_active "$wt"; then
    reason="sessão/processo ativo"
  fi

  if [ -n "$reason" ]; then
    printf '  skip   %-52s (%s)\n' "${wt/#$HOME/~}" "$reason"
    cur_wt=""
    cur_locked=0
    return 0
  fi

  sz="$(du_mb "$nm")" && rc=0 || rc=$?
  planned=$((planned + 1))
  if [ "$rc" -eq 0 ]; then
    freed=$((freed + sz))
  else
    sem_medida=$((sem_medida + 1)) # ausente ≠ zero: não entra no total
  fi

  if [ "$YES" -eq 1 ]; then
    if is_active "$wt"; then # re-checagem: fecha a corrida com install tardio
      printf '  skip   %-52s (ficou ativo)\n' "${wt/#$HOME/~}"
      cur_wt=""
      cur_locked=0
      return 0
    fi
    trash="$wt/.node_modules.trash.$$"
    if mv "$nm" "$trash" 2>/dev/null; then
      rm -rf "$trash" &
      printf '  CLEAN  %-52s %s\n' "${wt/#$HOME/~}" "$(medida_humana "$sz" "$rc")"
    else
      printf '  skip   %-52s (mv falhou)\n' "${wt/#$HOME/~}"
      planned=$((planned - 1))
      if [ "$rc" -eq 0 ]; then freed=$((freed - sz)); else sem_medida=$((sem_medida - 1)); fi
    fi
  else
    printf '  would  %-52s %s\n' "${wt/#$HOME/~}" "$(medida_humana "$sz" "$rc")"
  fi
  cur_wt=""
  cur_locked=0
}

echo "Varrendo worktrees…"
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      flush
      cur_wt="${line#worktree }"
      cur_locked=0
      ;;
    locked*) cur_locked=1 ;;
    "") flush ;;
  esac
done < <(git worktree list --porcelain)
flush
wait 2>/dev/null || true # só depois de TODO `rm` terminar o `df` de baixo vale
if [ "$YES" -eq 1 ]; then
  livre_depois="$(df_livre_mb "$self")" || livre_depois=""
fi

echo
medidos=$((planned - sem_medida))
piso=""
[ "$sem_medida" -gt 0 ] && piso=" (piso — medidos: ${medidos} de ${planned})"
if [ "$YES" -eq 1 ]; then
  echo "✅ apagado o node_modules de ${planned} worktree(s) — ~${freed} MB APARENTES${piso} (soma de du). Pra reusar um: cd lá + bun install."
  if [ -n "$livre_antes" ] && [ -n "$livre_depois" ]; then
    printf '   disco livre de VERDADE (df): %s MB → %s MB (%+d MB).\n' "$livre_antes" "$livre_depois" "$((livre_depois - livre_antes))"
  else
    echo "   disco livre de VERDADE: sem medida (o df não respondeu) — não é 0 MB, é dado que falta."
  fi
  echo "   O aparente não é o que volta: o bun instala por clone do cache (APFS) e o du conta em cada pasta os blocos que elas dividem."
else
  echo "DRY-RUN: apagaria o node_modules de ${planned} worktree(s) — ~${freed} MB APARENTES${piso} (soma de du)."
  echo "         O disco que volta é uma fração disso (clone do cache do bun em APFS): medido em 2026-11-17, 77605 MB aparentes devolveram 1923 MB."
  echo "         Rode 'bun run wt:clean --yes' pra executar — ele mede o disco livre antes e depois."
fi
if [ "$sem_medida" -gt 0 ]; then
  echo "         sem medida: ${sem_medida} — não é 0 MB, é dado que falta (o total acima é PISO)."
fi
if [ "$SONDA_ATIVIDADE" -eq 0 ]; then
  echo "⚠️  lsof não respondeu: NÃO sei quais worktrees têm sessão viva, então este dry-run" >&2
  echo "   não é confiável — qualquer 'would' pode ser de uma sessão em uso. O --yes aborta." >&2
fi
