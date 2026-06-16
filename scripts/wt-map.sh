#!/usr/bin/env bash
# wt-map.sh — lista as worktrees com o ASSUNTO de cada sessão, pra você achar
# qual worktree é qual (em vez de decorar slugs aleatórios tipo happy-satoshi).
#
# O assunto vem, em ordem de prioridade:
#   1. rótulo manual que você definiu com `bun run wt:label "<assunto>"`
#      (gravado no git-dir da worktree — não polui o working tree);
#   2. fallback best-effort: o 1º prompt da sessão Claude daquela worktree, lido
#      do transcript em ~/.claude/projects (fail-soft — formato interno, pode
#      faltar; nunca quebra, mostra "—").
#
# Uso:
#   bun run wt:map                      # lista todas as worktrees + assunto
#   bun run wt:label "corrige RLS tint" # rotula a worktree ATUAL (sobrepõe o fallback)
set -euo pipefail

rp() { realpath "$1" 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }

# --- subcomando: label ------------------------------------------------------
if [ "${1:-}" = "label" ]; then
  shift
  text="$*"
  [ -n "$text" ] || { echo "uso: bun run wt:label \"<assunto da worktree atual>\"" >&2; exit 2; }
  gd="$(git rev-parse --git-dir 2>/dev/null)" || { echo "não estou num worktree git" >&2; exit 1; }
  printf '%s\n' "$text" >"$gd/wt-label"
  echo "✓ rótulo desta worktree: $text"
  exit 0
fi

self="$(rp "$PWD")"

# --- diretórios com sessão/processo viva (cwd dentro) -----------------------
active_file="$(mktemp -t wtmap)"
trap 'rm -f "$active_file"' EXIT
{
  for proc in claude bun node vite tsx vitest; do
    lsof -nP -a -c "$proc" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  done
} | while IFS= read -r d; do [ -n "$d" ] && rp "$d"; done | sort -u >"$active_file" 2>/dev/null || true

is_active() {
  local wt="$1" d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ "$d" = "$wt" ] && return 0
    case "$d/" in "$wt"/*) return 0 ;; esac
  done <"$active_file"
  return 1
}

# path da worktree -> diretório de transcript do Claude Code -----------------
enc() { printf '%s' "$1" | sed 's#[/.]#-#g'; }

subject_for() {
  local wt="$1" gd dir f
  gd="$(git -C "$wt" rev-parse --git-dir 2>/dev/null || true)"
  if [ -n "$gd" ] && [ -f "$gd/wt-label" ]; then
    head -1 "$gd/wt-label"; return
  fi
  dir="$HOME/.claude/projects/$(enc "$wt")"
  # shellcheck disable=SC2012  # nomes são UUID.jsonl (sem espaços) — ls -t é seguro e simples
  f="$(ls -t "$dir"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$f" ] || { echo "—"; return; }
  python3 - "$f" 2>/dev/null <<'PY' || echo "—"
import sys, json
out = "—"
try:
    with open(sys.argv[1]) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") != "user":
                continue
            m = d.get("message")
            c = m.get("content") if isinstance(m, dict) else d.get("content")
            if isinstance(c, list):
                t = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
            else:
                t = c if isinstance(c, str) else ""
            t = " ".join(t.split())
            if t and not t.startswith("<"):
                out = t[:48]
                break
except Exception:
    pass
print(out)
PY
}

# --- monta o mapa -----------------------------------------------------------
printf "%-2s %-26s %-34s %s\n" "" "WORKTREE" "BRANCH" "ASSUNTO"
echo "------------------------------------------------------------------------------------------------"
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  wt="$(rp "$wt")"
  base="$(basename "$wt")"
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [ "$wt" = "$self" ]; then mark="▸"
  elif is_active "$wt"; then mark="●"
  else mark="○"; fi
  subj="$(subject_for "$wt")"
  printf "%-2s %-26.26s %-34.34s %s\n" "$mark" "$base" "$branch" "$subj"
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')
echo ""
echo "▸ atual   ● sessão viva   ○ parada      |  rotule: bun run wt:label \"<assunto>\""
