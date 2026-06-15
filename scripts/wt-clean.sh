#!/usr/bin/env bash
# wt-clean.sh — libera disco/RAM apagando node_modules de worktrees PARADOS.
#
# Cada worktree do Afiação tem seu próprio node_modules (~580 MB). Com dezenas de
# worktrees, isso vira vários GB em disco e pressão de RAM ao rodar test/build na
# M2 8GB. Este comando varre TODOS os worktrees e apaga o node_modules dos que
# estão parados — sem destruir nada: pra voltar a usar é só `bun install`.
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
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "argumento desconhecido: $arg" >&2
      exit 2
      ;;
  esac
done

rp() { realpath "$1" 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }

self="$(rp "$PWD")"

# --- diretórios com processo vivo (cwd dentro) ------------------------------
active_file="$(mktemp -t wtclean)"
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
cur_wt=""
cur_locked=0

flush() {
  [ -n "$cur_wt" ] || return 0
  local wt nm reason="" sz trash
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

  sz="$(du -sm "$nm" 2>/dev/null | cut -f1)"
  sz="${sz:-0}"
  planned=$((planned + 1))
  freed=$((freed + sz))

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
      printf '  CLEAN  %-52s -%s MB\n' "${wt/#$HOME/~}" "$sz"
    else
      printf '  skip   %-52s (mv falhou)\n' "${wt/#$HOME/~}"
      planned=$((planned - 1))
      freed=$((freed - sz))
    fi
  else
    printf '  would  %-52s -%s MB\n' "${wt/#$HOME/~}" "$sz"
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
wait 2>/dev/null || true

echo
if [ "$YES" -eq 1 ]; then
  echo "✅ liberados ~${freed} MB em ${planned} worktree(s). Pra reusar um: cd lá + bun install."
else
  echo "DRY-RUN: liberaria ~${freed} MB em ${planned} worktree(s)."
  echo "         Rode 'bun run wt:clean --yes' pra executar."
fi
