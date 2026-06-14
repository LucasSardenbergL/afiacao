#!/usr/bin/env bash
# wt-status.sh — raio-X rápido de RAM / disco / worktrees. Rode quando o Mac
# ficar lento pra ver o que está pesando e se vale um `bun run wt:clean`.
#
# Não muda nada — só lê e reporta.
set -euo pipefail

rp() { realpath "$1" 2>/dev/null || echo "$1"; }
human_gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1073741824 }'; }

echo "═══ RAM (total 8 GB nesta máquina) ═══"
mem_total="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
pgsize="$(vm_stat 2>/dev/null | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')"
pgsize="${pgsize:-16384}"
# "disponível" ≈ páginas livres + inativas (o macOS recicla as inativas)
avail_pages="$(vm_stat 2>/dev/null | awk '
  /Pages free/         { gsub(/[.]/,"",$3); f=$3 }
  /Pages inactive/     { gsub(/[.]/,"",$3); i=$3 }
  /File-backed pages/  { gsub(/[.]/,"",$3); fb=$3 }
  END { print f + i + fb }')"
avail_bytes=$((avail_pages * pgsize))
echo "  total:      $(human_gb "$mem_total") GB"
echo "  disponível: $(human_gb "$avail_bytes") GB"
swap="$(sysctl -n vm.swapusage 2>/dev/null || true)"
[ -n "$swap" ] && echo "  swap:       $swap"
case "$swap" in
  *used\ =\ 0.00M*) : ;;
  *used*) echo "  ⚠️  swap em uso = RAM saturada. Feche apps/sessões ou rode wt:clean." ;;
esac

echo
echo "═══ disco (/) ═══"
df -h / 2>/dev/null | awk 'NR==1 || NR==2 { printf "  %s\n", $0 }'

echo
echo "═══ node_modules por worktree ═══"
total=0
n=0
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  nm="$(rp "$wt")/node_modules"
  if [ -e "$nm" ] && [ ! -L "$nm" ]; then
    sz="$(du -sm "$nm" 2>/dev/null | cut -f1)"
    total=$((total + ${sz:-0}))
    n=$((n + 1))
  fi
done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
echo "  ${n} worktree(s) com node_modules — ~${total} MB no total"

echo
echo "═══ sessões Claude vivas (cwd → worktree) ═══"
sessions="$(lsof -nP -a -c claude -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u)"
if [ -n "$sessions" ]; then
  while IFS= read -r s; do
    [ -n "$s" ] && echo "  ${s/#$HOME/~}"
  done <<<"$sessions"
else
  echo "  (nenhuma)"
fi

echo
echo "═══ top consumidores de memória (RSS) ═══"
ps -axo rss,comm 2>/dev/null | sort -rn | head -10 |
  awk '{ printf "  %6.0f MB  %s\n", $1 / 1024, $2 }'

echo
if [ "${total:-0}" -gt 2000 ]; then
  echo "💡 ~${total} MB presos em node_modules de worktrees parados."
  echo "   Rode 'bun run wt:clean' (dry-run) pra ver quanto dá pra liberar agora."
fi
