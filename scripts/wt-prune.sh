#!/usr/bin/env bash
# wt-prune.sh — remove worktrees FANTASMA (sessão morta + trabalho 100% salvo).
#
# Cada sessão Claude isolada vive numa git worktree. Quando a sessão fecha, a
# worktree FICA no disco (vira lixo na `git worktree list`). Este comando enxuga
# a lista removendo só as comprovadamente seguras — o que o wt:clean NÃO faz (ele
# só apaga node_modules; este apaga o worktree inteiro).
#
# SÓ remove uma worktree quando TODAS estas condições valem (desenho com o codex):
#   - não é a atual, não tem sessão/processo VIVO (lsof), não está `locked`;
#   - working tree limpo: `git status --porcelain --untracked-files=all` vazio;
#   - arquivos IGNORADOS só na allowlist de descartáveis (node_modules, dist, …);
#     um .env só passa se for byte-idêntico ao da worktree atual (senão pode ter
#     segredo único) — qualquer ignored fora disso BLOQUEIA a remoção;
#   - trabalho 100% salvo, por UM de:
#       (A) HEAD é ancestral de origin/main  → já está na main; ou
#       (B) a branch tem PR MERGEADO cujo headRefOid == HEAD → squash-merge, sem
#           commits locais posteriores ao merge (PR mergeado sozinho NÃO basta:
#           a branch pode ter avançado depois do merge).
#   - revalida tudo imediatamente antes do `git worktree remove` (sem --force);
#   - NUNCA apaga a branch (cleanup de branch é outra operação) — todo commit
#     fica recuperável com `git worktree add <path> <branch>`.
#
# `git fetch origin --prune` é OBRIGATÓRIO no início; se falhar, não remove nada.
#
# Uso:
#   bun run wt:prune          # DRY-RUN: classifica e mostra o que faria
#   bun run wt:prune --yes    # executa de verdade
set -euo pipefail

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) YES=1 ;;
    -h | --help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

rp() { realpath "$1" 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
self="$(rp "$PWD")"
ref_env_dir="$self" # referência p/ comparar .env (todas as worktrees têm cópia idêntica)

# --- fetch obrigatório ------------------------------------------------------
echo "Atualizando refs do origin (obrigatório p/ avaliar 'mergeada')…"
if ! git fetch origin --prune --quiet 2>/dev/null; then
  echo "❌ git fetch origin falhou — não removo nada às cegas. Cheque a rede e tente de novo." >&2
  exit 1
fi
if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  echo "❌ origin/main não existe após o fetch — abortando." >&2
  exit 1
fi

# --- mapa branch->headRefOid de PRs mergeados (best-effort) ------------------
prmap="$(mktemp -t wtprune)"
trap 'rm -f "$prmap" "$active_file" 2>/dev/null || true' EXIT
if ! { command -v gh >/dev/null 2>&1 \
  && gh pr list --state merged --limit 2000 --json headRefName,headRefOid \
       --jq '.[] | "\(.headRefOid)\t\(.headRefName)"' >"$prmap" 2>/dev/null; }; then
  : >"$prmap"
  echo "⚠️  gh indisponível — só o caminho (A) 'ancestral de origin/main' será usado." >&2
fi

# --- diretórios com processo vivo (cwd dentro) ------------------------------
active_file="$(mktemp -t wtpruneact)"
{
  for proc in claude bun node vite tsx vitest esbuild npm; do
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

# arquivos ignorados que NÃO são descartáveis (vazio = pode remover) ----------
ignored_blockers() {
  local wt="$1" p base
  git -C "$wt" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p' | while IFS= read -r p; do
    [ -n "$p" ] || continue
    base="$(basename "${p%/}")"
    case "$base" in
      node_modules | dist | build | .vite | .turbo | coverage | .DS_Store | *.log | *.tsbuildinfo) ;;
      .env | .env.*)
        if [ -f "$ref_env_dir/$base" ] \
          && [ "$(md5 -q "$wt/${p%/}" 2>/dev/null)" = "$(md5 -q "$ref_env_dir/$base" 2>/dev/null)" ]; then
          : # idêntico ao de referência → descartável
        else
          echo "$p"
        fi
        ;;
      *) echo "$p" ;;
    esac
  done
}

# elegível? define REASON. retorna 0 se pode remover -------------------------
classify() {
  local wt="$1" branch head dirty blk
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)" || { REASON="git ilegível"; return 1; }
  head="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || { REASON="git ilegível"; return 1; }

  dirty="$(git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' ')"
  [ "$dirty" != "0" ] && { REASON="trabalho não-commitado ($dirty)"; return 1; }

  blk="$(ignored_blockers "$wt" | head -3 | tr '\n' ' ')"
  [ -n "$blk" ] && { REASON="ignored não-descartável: $blk"; return 1; }

  if git -C "$wt" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    REASON="na main [$branch]"; return 0
  fi
  if awk -v b="$branch" -v h="$head" -F'\t' '$1==h && $2==b{f=1} END{exit !f}' "$prmap"; then
    REASON="PR mergeado, HEAD==oid [$branch]"; return 0
  fi
  REASON="trabalho não salvo na main [$branch]"; return 1
}

# --- varre os worktrees -----------------------------------------------------
removed=0; freed=0; kept=0
cur_wt=""; cur_locked=0

handle() {
  [ -n "$cur_wt" ] || return 0
  local wt sz; wt="$(rp "$cur_wt")"
  local short="${wt/#$HOME/~}"

  if [ "$wt" = "$self" ]; then printf '  skip    %-50s (atual)\n' "$short"; kept=$((kept+1)); return 0; fi
  if [ "$cur_locked" -eq 1 ]; then printf '  skip    %-50s (locked)\n' "$short"; kept=$((kept+1)); return 0; fi
  if is_active "$wt"; then printf '  skip    %-50s (sessão/processo ativo)\n' "$short"; kept=$((kept+1)); return 0; fi

  if ! classify "$wt"; then
    printf '  KEEP    %-50s (%s)\n' "$short" "$REASON"; kept=$((kept+1)); return 0
  fi

  sz="$(du -sm "$wt" 2>/dev/null | cut -f1)"; sz="${sz:-0}"
  if [ "$YES" -eq 1 ]; then
    # revalidação final (fecha corrida com sessão que reabriu / arquivo que mudou)
    if is_active "$wt" || ! classify "$wt"; then
      printf '  skip    %-50s (mudou na revalidação)\n' "$short"; kept=$((kept+1)); return 0
    fi
    if git worktree remove "$wt" 2>/tmp/wt-prune-err; then
      printf '  PRUNE   %-50s -%s MB (%s)\n' "$short" "$sz" "$REASON"
      removed=$((removed+1)); freed=$((freed+sz))
    else
      printf '  FALHOU  %-50s (%s)\n' "$short" "$(tr -d '\n' </tmp/wt-prune-err)"; kept=$((kept+1))
    fi
  else
    printf '  would   %-50s -%s MB (%s)\n' "$short" "$sz" "$REASON"
    removed=$((removed+1)); freed=$((freed+sz))
  fi
}

echo "Varrendo worktrees…"
while IFS= read -r line; do
  case "$line" in
    "worktree "*) handle; cur_wt="${line#worktree }"; cur_locked=0 ;;
    locked*) cur_locked=1 ;;
    "") handle; cur_wt=""; cur_locked=0 ;;
  esac
done < <(git worktree list --porcelain)
handle

[ "$YES" -eq 1 ] && git worktree prune 2>/dev/null || true

echo
if [ "$YES" -eq 1 ]; then
  echo "✅ removidas ${removed} worktree(s), ~${freed} MB liberados. ${kept} preservada(s)."
  echo "   Branches NÃO foram apagadas — recupere qualquer uma com: git worktree add <path> <branch>"
else
  echo "DRY-RUN: removeria ${removed} worktree(s) (~${freed} MB); preservaria ${kept}."
  echo "         Rode 'bun run wt:prune --yes' pra executar."
fi
