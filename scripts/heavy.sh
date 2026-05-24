#!/usr/bin/env bash
#
# heavy — semáforo GLOBAL pra tarefas pesadas (test/build/typecheck) rodando
# em paralelo entre vários worktrees/sessões, pra não saturar CPU+RAM.
#
# Por que existe: nesta máquina (M2 8GB) rodar `bun run test` / `typecheck:strict`
# em N worktrees ao mesmo tempo estoura a RAM (vira swap) e o load dispara pra 40+.
# Este wrapper garante que no máximo SLOTS comandos pesados rodem simultaneamente;
# os demais ESPERAM a vez (bloqueante), sem você precisar coordenar na mão.
#
# Uso:
#   heavy bun run test
#   heavy bun run typecheck:strict
#   heavy bun build
#   heavy --status        # mostra slots em uso e a config calculada
#
# Tuning (env, opcional):
#   AFIACAO_MAX_HEAVY=2        força nº de slots (default = calculado por HW)
#   AFIACAO_HEAVY_TIMEOUT=1800 segundos máx esperando uma vaga (default 30min)
#   AFIACAO_HEAVY_LOCKDIR=...  dir dos locks (default /tmp/afiacao-heavy-slots)
#
set -euo pipefail

LOCK_ROOT="${AFIACAO_HEAVY_LOCKDIR:-/tmp/afiacao-heavy-slots}"
POLL=2
MAX_WAIT="${AFIACAO_HEAVY_TIMEOUT:-1800}"

# nº de slots = min(P-cores-1, RAM-folga). Calcula sozinho — funciona igual
# numa M2 8GB (=1) e num MacBook Pro M4 Pro 48GB (~9).
compute_slots() {
  local pcores ram_gb cpu_lim ram_lim n
  pcores=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
  ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1073741824 ))
  cpu_lim=$(( pcores > 1 ? pcores - 1 : 1 ))
  ram_lim=$(( (ram_gb - 4) / 3 )); [ "$ram_lim" -lt 1 ] && ram_lim=1
  n=$(( cpu_lim < ram_lim ? cpu_lim : ram_lim ))
  [ "$n" -lt 1 ] && n=1
  echo "$n"
}
SLOTS="${AFIACAO_MAX_HEAVY:-$(compute_slots)}"
mkdir -p "$LOCK_ROOT"

if [ "${1:-}" = "--status" ]; then
  echo "heavy: $SLOTS slot(s) no total (lockdir: $LOCK_ROOT)"
  busy=0
  for slot in "$LOCK_ROOT"/slot-*; do
    [ -d "$slot" ] || continue
    pid=$(cat "$slot/pid" 2>/dev/null || echo "?")
    cmd=$(cat "$slot/cmd" 2>/dev/null || echo "?")
    if [ "$pid" != "?" ] && kill -0 "$pid" 2>/dev/null; then
      busy=$((busy+1)); echo "  • $(basename "$slot"): pid $pid — $cmd"
    fi
  done
  echo "heavy: $busy em uso, $((SLOTS - busy)) livre(s)"
  exit 0
fi

[ $# -eq 0 ] && { echo "uso: heavy <comando...>   (ou: heavy --status)" >&2; exit 2; }

ACQUIRED=""
release() { [ -n "$ACQUIRED" ] && rm -rf "$ACQUIRED" 2>/dev/null || true; }
trap release EXIT INT TERM

acquire() {
  local waited=0 i slot pid
  while :; do
    # recupera slots órfãos (dono morreu sem liberar)
    for slot in "$LOCK_ROOT"/slot-*; do
      [ -d "$slot" ] || continue
      pid=$(cat "$slot/pid" 2>/dev/null || echo "")
      [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && rm -rf "$slot" 2>/dev/null || true
    done
    # tenta pegar uma vaga (mkdir é atômico)
    for i in $(seq 1 "$SLOTS"); do
      slot="$LOCK_ROOT/slot-$i"
      if mkdir "$slot" 2>/dev/null; then
        echo "$$" > "$slot/pid"
        echo "$*" > "$slot/cmd"
        ACQUIRED="$slot"
        return 0
      fi
    done
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      echo "heavy: timeout (${MAX_WAIT}s) esperando vaga — abortando." >&2
      return 1
    fi
    [ "$waited" -eq 0 ] && echo "heavy: $SLOTS slot(s) ocupado(s), aguardando vez… ($*)" >&2
    sleep "$POLL"; waited=$((waited + POLL))
  done
}

acquire "$@" || exit 1
echo "heavy: ► rodando ($(basename "$ACQUIRED")/$SLOTS): $*" >&2
"$@"
