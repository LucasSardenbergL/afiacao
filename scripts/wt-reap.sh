#!/usr/bin/env bash
# wt-reap.sh — mata processos de dev ÓRFÃOS pra aliviar RAM na M2 8GB.
#
# Irmão do wt-clean: enquanto o wt-clean apaga node_modules de worktrees parados,
# o wt-reap derruba PROCESSOS de dev (vitest/esbuild) que sobraram de sessões já
# mortas — eles seguem comendo RAM sem dono. Um vitest de uma sessão Claude VIVA
# é trabalho legítimo e é POUPADO.
#
# SEGURANÇA (mesma espinha do wt-clean):
#   - só mexe em processo cujo cwd está DENTRO de um worktree DESTE projeto;
#   - POUPA o worktree atual (a sessão que você usa agora);
#   - POUPA todo worktree com sessão `claude` viva (cwd lá, via lsof) — nunca
#     mata o teste de quem trabalha; no aninhamento worktree-dentro-de-principal
#     vale o match MAIS LONGO (o filho morto não é salvo por um claude vivo no
#     principal);
#   - SIGTERM (não -9): o processo encerra limpo;
#   - DRY-RUN por padrão — só lista; `--yes` executa.
#
# Uso:
#   bun run wt:reap          # DRY-RUN: mostra o que mataria
#   bun run wt:reap --yes    # mata de verdade
set -u

rp() { realpath "$1" 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }

# worktree (de all_f) que CONTÉM `path`, escolhendo o match MAIS LONGO (= mais
# específico; resolve worktree-dentro-de-principal). Vazio se nenhum contém.
wt_containing() {
  local path="$1" all_f="$2" best="" wt
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    case "$path/" in
      "$wt"/*) [ "${#wt}" -gt "${#best}" ] && best="$wt" ;;
    esac
  done <"$all_f"
  printf '%s' "$best"
}

# decisão pura: lê "pid<TAB>cwd<TAB>cmd" no stdin, imprime os que devem MORRER.
#   reap_decide <self> <all_wts_file> <alive_wts_file>
reap_decide() {
  local self="$1" all_f="$2" alive_f="$3" pid cwd cmd wt
  while IFS=$'\t' read -r pid cwd cmd; do
    [ -n "${pid:-}" ] || continue
    wt="$(wt_containing "$cwd" "$all_f")"
    [ -n "$wt" ] || continue                # fora do projeto → não é da nossa conta
    [ "$wt" = "$self" ] && continue          # worktree atual → poupa
    grep -qxF "$wt" "$alive_f" && continue    # sessão claude viva → poupa
    printf '%s\t%s\t%s\n' "$pid" "$cwd" "$cmd"
  done
}

# coleta processos de dev (vitest/esbuild) → "pid<TAB>cwd<TAB>cmd"
collect_dev_procs() {
  local pid rest cwd
  ps -axww -o pid=,command= 2>/dev/null | while read -r pid rest; do
    case "$rest" in
      *vitest* | *esbuild*) ;;
      *) continue ;;
    esac
    cwd="$(lsof -nP -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ -n "$cwd" ] || continue
    printf '%s\t%s\t%s\n' "$pid" "$(rp "$cwd")" "$rest"
  done
}

main() {
  set -uo pipefail
  local YES=0 arg
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) YES=1 ;;
      -h | --help)
        sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *)
        echo "argumento desconhecido: $arg" >&2
        exit 2
        ;;
    esac
  done

  # tmp é global de propósito: o trap EXIT precisa enxergá-lo depois que main retorna
  tmp="$(mktemp -d)"
  trap '[ -n "${tmp:-}" ] && rm -rf "$tmp"' EXIT
  local all_f="$tmp/all" alive_f="$tmp/alive" procs_f="$tmp/procs" targets_f="$tmp/targets"
  local self
  self="$(rp "$PWD")"

  git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' |
    while IFS= read -r w; do rp "$w"; done | sort -u >"$all_f"

  lsof -nP -a -c claude -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' |
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      wt_containing "$(rp "$d")" "$all_f"
      echo
    done | sed '/^$/d' | sort -u >"$alive_f"

  collect_dev_procs >"$procs_f"
  reap_decide "$self" "$all_f" "$alive_f" <"$procs_f" >"$targets_f"

  local n
  n="$(grep -c . "$targets_f" 2>/dev/null || true)"
  n="${n:-0}"
  echo "Worktrees: $(grep -c . "$all_f" || echo 0) · com sessão viva: $(grep -c . "$alive_f" || echo 0) · dev-procs órfãos: $n"
  if [ "$n" -eq 0 ]; then
    echo "✅ Nada a fazer — todo vitest/esbuild é de sessão viva (ou do worktree atual)."
    return 0
  fi

  local pid cwd cmd killed=0
  while IFS=$'\t' read -r pid cwd cmd; do
    [ -n "$pid" ] || continue
    if [ "$YES" -eq 1 ]; then
      if kill -TERM "$pid" 2>/dev/null; then
        killed=$((killed + 1))
        printf '  REAP   pid %-7s %s\n' "$pid" "${cwd/#$HOME/~}"
      else
        printf '  gone   pid %-7s (já saiu)\n' "$pid"
      fi
    else
      printf '  would  pid %-7s %s\n' "$pid" "${cwd/#$HOME/~}"
    fi
  done <"$targets_f"

  echo
  if [ "$YES" -eq 1 ]; then
    echo "✅ derrubei ${killed} processo(s) órfão(s)."
  else
    echo "DRY-RUN: mataria ${n} processo(s). Rode 'bun run wt:reap --yes' pra executar."
  fi
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
