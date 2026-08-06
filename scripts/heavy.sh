#!/usr/bin/env bash
#
# heavy — semáforo GLOBAL pra tarefas pesadas (test/build/typecheck) rodando
# em paralelo entre vários worktrees/sessões, pra não saturar CPU+RAM.
#
# Por que existe: nesta máquina (M2 8GB) rodar `bun run test` / `typecheck:strict`
# em N worktrees ao mesmo tempo estoura a RAM (vira swap) e o load dispara pra 40+.
# Este wrapper garante que no máximo SLOTS comandos pesados rodem simultaneamente;
# os demais ESPERAM a vez (bloqueante, em ORDEM DE CHEGADA), sem você coordenar na mão.
#
# Uso:
#   heavy bun run test
#   heavy bun run typecheck:strict
#   heavy bun build
#   heavy --status        # slots em uso, fila de espera e a config calculada
#
# Tuning (env, opcional):
#   AFIACAO_MAX_HEAVY=2        força nº de slots (default = calculado por HW)
#   AFIACAO_HEAVY_TIMEOUT=1800 segundos máx esperando uma vaga (default 30min)
#   AFIACAO_HEAVY_LOCKDIR=...  dir dos locks (default /tmp/afiacao-heavy-slots)
#
# ── Três invariantes que este script sustenta (cada uma nasceu de um bug real,
#    observado em 2026-07-18 com ~24 sessões Claude e 40 worktrees ativas):
#
# 1. A VAGA SÓ VOLTA QUANDO A RAM VOLTA. O trap mata a ÁRVORE do comando filho
#    (grupo de processos) ANTES de liberar o slot. Antes: matar o wrapper deixava
#    `bun`→`node tsc` vivos e devolvia a vaga — o semáforo mentia, outro job
#    entrava por cima, e o órfão seguia comendo a RAM cuja falta causou a espera.
#
# 2. CAPACIDADE É CONTAGEM, NÃO ÍNDICE. A admissão compara `slots vivos` com o
#    total; nunca "existe o índice slot-N livre?". Antes, com o total recalculado
#    a cada invocação, o mesmo defeito dava os dois sinais: índices baixos ocupados
#    → travava e `--status` dizia "-1 livre(s)"; índices altos ocupados → sobrava
#    índice baixo e um 3º job furava um teto de 2.
#    POLÍTICA (escolhida entre persistir-o-total / piso-dinâmico / sobre-inscrição):
#    → PISO DINÂMICO. O total segue sendo recalculado (acompanha a RAM real, que é
#      o ponto do semáforo), mas as vagas livres saturam em 0 — nunca negativo.
#      Se o total encolhe abaixo do que já roda, ninguém novo entra até drenar, e o
#      `--status` diz isso em palavras. Rejeitadas: persistir congela um número
#      medido num instante arbitrário (e a "primeira invocação" é ela própria uma
#      corrida); sobre-inscrever é justamente o que o bug fazia por acidente — e o
#      oposto do propósito numa máquina que já está em swap.
#
# 3. QUEM CHEGA PRIMEIRO ENTRA PRIMEIRO. Fila FIFO por ticket (timestamp ns no
#    lockdir): um waiter só tenta a vaga se estiver entre os primeiros da fila.
#    Antes era polling puro — quem acordava no instante certo levava o slot, e
#    sessões antigas passavam fome (medido: 21min05 de espera perdendo para 2min00).
#
set -euo pipefail

LOCK_ROOT="${AFIACAO_HEAVY_LOCKDIR:-/tmp/afiacao-heavy-slots}"
QUEUE_DIR="$LOCK_ROOT/fila"
POLL=2
MAX_WAIT="${AFIACAO_HEAVY_TIMEOUT:-1800}"
# slot recém-criado ainda sem `pid` no disco conta como ocupado por este tempo:
# fecha a janela entre o mkdir e a escrita do pid (senão outro waiter conta "livre").
SLOT_GRACE=15

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
mkdir -p "$LOCK_ROOT" "$QUEUE_DIR"

# ─────────────────────────────────────────────────────────── helpers de estado

# Timestamp em nanossegundos, zero-padded a 19 dígitos pra ordenar lexicográfico.
# `date +%s%N` é nativo no Darwin moderno, mas BSD antigo devolve "…N" literal —
# por isso valida que só veio dígito e cai pro perl (sempre presente no macOS).
agora_ns() {
  local ns
  ns=$(date +%s%N 2>/dev/null || echo "")
  case "$ns" in ''|*[!0-9]*) ns="" ;; esac
  if [ -z "$ns" ]; then
    ns=$(perl -MTime::HiRes -e 'printf "%.0f", Time::HiRes::time()*1000000000' 2>/dev/null || echo "")
    case "$ns" in ''|*[!0-9]*) ns="" ;; esac
  fi
  if [ -z "$ns" ]; then ns=$(( $(date +%s) * 1000000000 )); fi
  printf '%019d' "$ns"
}

mtime_de() { stat -f %m "$1" 2>/dev/null || echo 0; }

# Um slot conta como OCUPADO se o dono está vivo, ou se acabou de ser criado
# (ainda escrevendo o pid). Qualquer outra coisa é órfão e será recolhido.
slot_ocupado() {
  local slot="$1" pid agora
  [ -d "$slot" ] || return 1
  pid=$(cat "$slot/pid" 2>/dev/null || echo "")
  if [ -n "$pid" ]; then
    kill -0 "$pid" 2>/dev/null && return 0
    return 1
  fi
  agora=$(date +%s)
  [ $(( agora - $(mtime_de "$slot") )) -lt "$SLOT_GRACE" ]
}

# Recolhe slots de donos mortos e tickets de waiters mortos (o dono do ticket
# está no próprio nome: <ns>-<pid>). É o que já existia pros slots, estendido
# à fila — sem isso um waiter morto bloquearia a fila inteira atrás dele.
limpar_orfaos() {
  local slot t pid
  for slot in "$LOCK_ROOT"/slot-*; do
    [ -d "$slot" ] || continue
    slot_ocupado "$slot" || rm -rf "$slot" 2>/dev/null || true
  done
  for t in "$QUEUE_DIR"/*; do
    [ -e "$t" ] || continue
    pid="${t##*-}"
    case "$pid" in
      ''|*[!0-9]*) rm -f "$t" 2>/dev/null || true; continue ;;
    esac
    kill -0 "$pid" 2>/dev/null || rm -f "$t" 2>/dev/null || true
  done
}

slots_vivos() {
  local slot n=0
  for slot in "$LOCK_ROOT"/slot-*; do
    [ -d "$slot" ] || continue
    if slot_ocupado "$slot"; then n=$((n+1)); fi
  done
  echo "$n"
}

# Fila em ordem de chegada. LC_ALL=C no sort garante ordem byte-wise estável
# entre processos (o prefixo de 19 dígitos já ordena cronologicamente).
fila_ordenada() {
  local t
  for t in "$QUEUE_DIR"/*; do
    [ -e "$t" ] || continue
    printf '%s\n' "${t##*/}"
  done | LC_ALL=C sort
}

# Posição 1-based do meu ticket; 0 se ele sumiu (foi recolhido como órfão).
posicao_na_fila() {
  local me="$1" pos=1 t
  while IFS= read -r t; do
    [ "$t" = "$me" ] && { echo "$pos"; return 0; }
    pos=$((pos+1))
  done <<EOF
$(fila_ordenada)
EOF
  echo 0
}

espera_de() {   # segundos que o ticket <ns>-<pid> já esperou
  local ns="${1%%-*}" agora
  agora=$(agora_ns)
  echo $(( (10#$agora - 10#$ns) / 1000000000 ))
}

fmt_espera() {
  local s="$1"
  if [ "$s" -ge 60 ]; then echo "$((s/60))min$(printf '%02d' $((s%60)))s"; else echo "${s}s"; fi
}

# ──────────────────────────────────────────────────────────────────── --status

if [ "${1:-}" = "--status" ]; then
  limpar_orfaos
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
  # PISO DINÂMICO: livres satura em 0. Sobrecarga (total encolheu abaixo do que
  # já roda) vira frase legível, não um "-1 livre(s)" que ninguém sabe ler.
  livres=$(( SLOTS - busy )); [ "$livres" -lt 0 ] && livres=0
  fila_n=$(fila_ordenada | grep -c . || true)
  if [ "$busy" -gt "$SLOTS" ]; then
    echo "heavy: $busy em uso, $livres livre(s) — $((busy - SLOTS)) acima do teto atual ($SLOTS); drenando, sem admissão nova"
  else
    echo "heavy: $busy em uso, $livres livre(s)"
  fi
  if [ "$fila_n" -gt 0 ]; then
    echo "heavy: $fila_n na fila (ordem de chegada):"
    pos=1
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      echo "  $pos. pid ${t##*-} — esperando há $(fmt_espera "$(espera_de "$t")") — $(cat "$QUEUE_DIR/$t" 2>/dev/null || echo '?')"
      pos=$((pos+1))
    done <<EOF
$(fila_ordenada)
EOF
  fi
  exit 0
fi

[ $# -eq 0 ] && { echo "uso: heavy <comando...>   (ou: heavy --status)" >&2; exit 2; }

# ───────────────────────────────────────────────────── cleanup (BUG 1: o trap)

ACQUIRED=""
TICKET=""
CHILD=""
CLEANED=0

# Idempotente: TERM dispara o trap do sinal E depois o de EXIT. Sem o guard, o
# segundo `rm -rf` apagaria um slot que outro processo já tivesse recriado.
# shellcheck disable=SC2329  # invocada indiretamente pelos traps logo abaixo
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  # 1º a ÁRVORE do filho. `set -m` põe o filho como líder do próprio grupo, então
  # `kill -TERM -PID` alcança netos (bun → node tsc) que o kill no wrapper perdia.
  if [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; then
    kill -TERM "-$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null || true
    i=0
    while [ "$i" -lt 20 ] && kill -0 "$CHILD" 2>/dev/null; do sleep 0.1; i=$((i+1)); done
    if kill -0 "$CHILD" 2>/dev/null; then
      kill -KILL "-$CHILD" 2>/dev/null || kill -KILL "$CHILD" 2>/dev/null || true
    fi
  fi
  # 2º a vaga — só depois de a RAM ter sido de fato devolvida.
  if [ -n "$ACQUIRED" ]; then rm -rf "$ACQUIRED" 2>/dev/null || true; fi
  if [ -n "$TICKET" ]; then rm -f "$QUEUE_DIR/$TICKET" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ────────────────────────────────────────────────── acquire (BUGs 2 e 3)

acquire() {
  local waited_ms=0 vivos vagas pos pos_ant=-1 i slot teto
  TICKET="$(agora_ns)-$$"
  printf '%s\n' "$*" > "$QUEUE_DIR/$TICKET"

  while :; do
    limpar_orfaos
    vivos=$(slots_vivos)
    vagas=$(( SLOTS - vivos ))            # piso dinâmico: negativo = sobrecarga, ninguém entra
    pos=$(posicao_na_fila "$TICKET")

    # Só tenta se couber nas vagas E for a minha vez. É isso que troca "quem
    # acordou primeiro" por "quem chegou primeiro": os de trás VEEM a vaga livre
    # e voltam a dormir de propósito.
    if [ "$vagas" -gt 0 ] && [ "$pos" -ge 1 ] && [ "$pos" -le "$vagas" ]; then
      # menor índice livre. O teto cobre índices esparsos herdados de um total
      # maior; estourar é fail-safe (volta a esperar, não sobre-inscreve).
      teto=$(( SLOTS + 16 )); i=1
      while [ "$i" -le "$teto" ]; do
        slot="$LOCK_ROOT/slot-$i"
        if mkdir "$slot" 2>/dev/null; then
          printf '%s\n' "$$" > "$slot/pid"
          printf '%s\n' "$*" > "$slot/cmd"
          ACQUIRED="$slot"
          rm -f "$QUEUE_DIR/$TICKET" 2>/dev/null || true
          TICKET=""
          return 0
        fi
        i=$((i+1))
      done
    fi

    if [ "$waited_ms" -ge $(( MAX_WAIT * 1000 )) ]; then
      echo "heavy: timeout (${MAX_WAIT}s) esperando vaga — abortando. (posição $pos na fila)" >&2
      return 1
    fi
    if [ "$pos" != "$pos_ant" ]; then
      if [ "$vivos" -gt "$SLOTS" ]; then
        echo "heavy: $vivos em uso acima do teto ($SLOTS) — drenando; você é o $pos º da fila… ($*)" >&2
      else
        echo "heavy: $SLOTS slot(s) ocupado(s), você é o $pos º da fila… ($*)" >&2
      fi
      pos_ant="$pos"
    fi

    # Poll ADAPTATIVO por posição. O FIFO tem um custo que o polling desordenado
    # não tinha: como só a cabeça da fila pode ocupar a vaga, ela fica ociosa a
    # cada handoff até esse waiter específico acordar. Medido com 24 waiters e
    # jobs curtos: 10s (desordenado) → 50s (FIFO com poll único de 2s). Quem está
    # prestes a entrar checa rápido; o resto da fila segue no POLL barato — só
    # um punhado de processos paga CPU de poll curto, não os 24.
    # A janela é SLOTS+2, não SLOTS: quem acabou de virar cabeça precisa PERCEBER
    # isso rápido. Cobrindo só a cabeça atual, a transição 2→1 ainda pagava um
    # ciclo lento inteiro a cada handoff (28s no mesmo teste; com +2, ~12s).
    if [ "$pos" -ge 1 ] && [ "$pos" -le $(( SLOTS + 2 )) ]; then
      sleep 0.2; waited_ms=$(( waited_ms + 200 ))
    else
      sleep "$POLL"; waited_ms=$(( waited_ms + POLL * 1000 ))
    fi
  done
}

acquire "$@" || exit 1
echo "heavy: ► rodando ($(basename "$ACQUIRED")/$SLOTS): $*" >&2

# `set -m` = job control: o filho vira líder do próprio grupo de processos, o que
# torna `kill -TERM -$CHILD` capaz de derrubar a árvore toda no cleanup.
set -m
"$@" &
CHILD=$!
rc=0
wait "$CHILD" || rc=$?
CHILD=""        # terminou sozinho: o cleanup não tem árvore pra matar
exit "$rc"
