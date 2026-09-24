#!/usr/bin/env bash
# claude-mem-reanimar.sh — diagnostica o worker do claude-mem e, com evidencia
# POSITIVA + sua confirmacao, recupera. E a receita de 05/09
# (docs/historico/claude-mem-worker-vivo-mas-surdo.md) generalizada para qualquer versao.
#
# Uso:  bash claude-mem-reanimar.sh              diagnostico + pergunta antes de matar
#       bash claude-mem-reanimar.sh --so-olhar   so diagnostico (nao toca em nada)
#
# So mata processo do PROPRIO claude-mem (worker-service.cjs, ou chroma-mcp com o
# data-dir dele) e so quando a porta falha em 3 sondas seguidas. Sonda que nao
# responde de forma interpretavel = "nao sei" = nao mata.
# Saida: 0 = worker saudavel e hook passando · 1 = nao consegui · 2 = parei por falta de dado.
set -u

SO_OLHAR=0
[ "${1:-}" = "--so-olhar" ] && SO_OLHAR=1

DATA="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CACHE="$CFG/plugins/cache/thedotmack/claude-mem"
PIDF="$DATA/worker.pid"
CONTF="$DATA/state/hook-failures.json"

titulo() { printf '\n== %s\n' "$*"; }
# "chave": 123 ou "chave": "123" num JSON (sed, nao jq: o PATH do app pode nao ter jq)
campo() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([0-9][0-9]*\).*/\1/p" "$2" 2>/dev/null | head -1; }
confirma() {
  local r=""
  printf '%s [s/N] ' "$1"
  read -r r </dev/tty || r=""
  case "$r" in s | S | sim | SIM) return 0 ;; *) return 1 ;; esac
}
# curl -> "rc http"
sonda() {
  local http rc
  http="$(curl -s -o /dev/null -w '%{http_code}' -m "${2:-3}" --noproxy '*' "http://$HOST:$PORT$1" 2>/dev/null)"
  rc=$?
  printf '%s %s' "$rc" "${http:-000}"
}
# "rc http" -> ok | erro-http | recusada (nada escuta) | surdo (escuta, nao atende) | nao-sondei
classe() {
  case "$1" in
    "0 200") echo ok ;;
    0\ *) echo erro-http ;;
    7\ *) echo recusada ;;
    28\ * | 52\ * | 55\ * | 56\ *) echo surdo ;;
    *) echo nao-sondei ;;
  esac
}
segundos_de_vida() { # etime ([[dd-]hh:]mm:ss) -> segundos; vazio se nao leu
  local e d=0 h=0 m=0 s=0 a b c
  e="$(ps -p "$1" -o etime= 2>/dev/null | tr -d ' ')"
  [ -n "$e" ] || return 0
  case "$e" in *-*) d="${e%%-*}"; e="${e#*-}" ;; esac
  IFS=: read -r a b c <<<"$e"
  if [ -n "${c:-}" ]; then h=$a; m=$b; s=$c; else m=$a; s=${b:-0}; fi
  echo $((10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}
comando_de() { ps -p "$1" -o command= 2>/dev/null; }
eh_do_claude_mem() { # o processo e do claude-mem? (worker, ou chroma-mcp com o data-dir dele)
  local c
  c="$(comando_de "$1")"
  case "$c" in
    *worker-service.cjs*) return 0 ;;
    *chroma-mcp*"$DATA"*) return 0 ;;
  esac
  return 1
}
arvore() { # pid raiz + descendentes (por ppid) + mesmo pgid quando a raiz lidera o grupo
  ps -A -o pid=,ppid=,pgid= 2>/dev/null | awk -v r="$1" '
    { pid[NR]=$1; pp[NR]=$2; pg[NR]=$3 }
    END {
      alvo[r]=1; mudou=1
      while (mudou) { mudou=0
        for (i=1;i<=NR;i++) if (((pp[i] in alvo) || pg[i]==r) && !(pid[i] in alvo)) { alvo[pid[i]]=1; mudou=1 } }
      for (p in alvo) if ((p+0) > 1) print p
    }'
}
# 3 sondas em ~10s, todas falhando de forma interpretavel (nunca "nao-sondei") -> confirmado
surdez_confirmada() {
  local i cl
  for i in 1 2 3; do
    cl="$(classe "$(sonda /api/health 5)")"
    case "$cl" in surdo | recusada | erro-http) ;; *) echo "  sonda $i: $cl — nao confirmo a falha"; return 1 ;; esac
    echo "  sonda $i: $cl"
    [ "$i" -lt 3 ] && sleep 2
  done
  return 0
}
ver_num() { # "13.24.8" -> 13024008
  local IFS=.
  # shellcheck disable=SC2086  # split intencional: IFS=. quebra a versao em campos
  set -- ${1%%-*}
  echo $((${1:-0} * 1000000 + ${2:-0} * 1000 + ${3:-0}))
}

# ---------------------------------------------------------------- 1. instalacao
titulo "1. instalacao (a mesma que o hook resolve)"
P=""; VER=""
if [ -d "$CACHE" ]; then
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    [ -e "$CACHE/$v/.orphaned_at" ] && continue
    for q in "$CACHE/$v/plugin" "$CACHE/$v"; do
      if [ -f "$q/scripts/bun-runner.js" ] && [ -f "$q/scripts/worker-service.cjs" ]; then P="$q/scripts"; VER="$v"; break 2; fi
    done
  done < <(find "$CACHE" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -exec basename {} \; 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr)
fi
if [ -z "$P" ] && [ -f "$CFG/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs" ]; then
  P="$CFG/plugins/marketplaces/thedotmack/plugin/scripts"; VER="marketplace"
fi
if [ -z "$P" ]; then
  echo "claude-mem nao encontrado em $CACHE nem no marketplace. Parei (nada a recuperar aqui)."; exit 2
fi
echo "versao ativa: $VER"
echo "scripts:      $P"
if [ "$VER" != marketplace ] && [ "$(ver_num "$VER")" -lt "$(ver_num 13.24.18)" ]; then
  echo "ATENCAO: < 13.24.18 bloqueia TODO prompt enquanto o worker estiver fora (>= 13.24.18 bloqueia 1x e libera)."
fi
NODE="$(command -v node || true)"
[ -n "$NODE" ] || echo "AVISO: 'node' nao esta no PATH deste terminal — sem ele nao consigo dar start."

# ---------------------------------------------------------------- 2. estado
titulo "2. estado do worker"
PORT="${CLAUDE_MEM_WORKER_PORT:-}"
[ -z "$PORT" ] && [ -f "$DATA/settings.json" ] && PORT="$(campo CLAUDE_MEM_WORKER_PORT "$DATA/settings.json")"
[ -z "$PORT" ] && PORT=$((37700 + $(id -u) % 100))
# o MESMO host que o hook usa (default 127.0.0.1; configuravel em settings.json)
HOST="${CLAUDE_MEM_WORKER_HOST:-}"
[ -z "$HOST" ] && [ -f "$DATA/settings.json" ] && HOST="$(sed -n 's/.*"CLAUDE_MEM_WORKER_HOST"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DATA/settings.json" 2>/dev/null | head -1)"
case "$HOST" in
  "" | 0.0.0.0) HOST=127.0.0.1 ;;
  :: | ::0) HOST="[::1]" ;;
  *:*) HOST="[$HOST]" ;;
esac
PID=""; PIDPORT=""
if [ -f "$PIDF" ]; then PID="$(campo pid "$PIDF")"; PIDPORT="$(campo port "$PIDF")"; fi
echo "endereco do hook: $HOST:$PORT${PIDPORT:+  (worker.pid diz porta $PIDPORT)}"
VIVO=0; EH_WORKER=0
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  VIVO=1
  case "$(comando_de "$PID")" in *worker-service.cjs*) EH_WORKER=1 ;; esac
  echo "worker.pid: $PID VIVO ha $(segundos_de_vida "$PID")s — $(comando_de "$PID" | cut -c1-110)"
  ps -p "$PID" -o pcpu=,time=,stat= 2>/dev/null | awk '{print "            cpu " $1 "% · tempo de cpu " $2 " · estado " $3}'
  [ "$EH_WORKER" = 1 ] || echo "            (esse pid NAO e o worker: o worker.pid ficou velho e o numero foi reciclado)"
else
  echo "worker.pid: ${PID:-ausente}${PID:+ (processo MORTO)}"
fi
H="$(sonda /api/health 3)"; HC="$(classe "$H")"
R="$(sonda /api/readiness 3)"; RC="$(classe "$R")"
echo "health:    $HC (curl rc/http = $H)"
echo "readiness: $RC (curl rc/http = $R)"
DONOS=""
if command -v lsof >/dev/null 2>&1; then
  DONOS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ')"
  for d in $DONOS; do echo "escutando na porta: pid $d — $(comando_de "$d" | cut -c1-110)"; done
fi
if [ -f "$CONTF" ]; then echo "contador de falhas: $(tr -d ' \n' <"$CONTF" | cut -c1-120)"; else echo "contador de falhas: (sem arquivo)"; fi

# ---------------------------------------------------------------- 3. memoria
titulo "3. a memoria esta de fato gravando? (so leitura)"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA/claude-mem.db" ]; then
  U="$(sqlite3 -readonly -cmd '.timeout 3000' "$DATA/claude-mem.db" 'select max(created_at) from observations;' 2>&1 | tail -1)"
  echo "ultima observacao gravada: ${U:-(nenhuma)}"
else
  echo "sem sqlite3 ou sem $DATA/claude-mem.db — nao medi (falta de dado, nao 'ok')"
fi
LOG="$(find "$DATA/logs" -maxdepth 1 -name 'claude-mem-*.log' 2>/dev/null | sort | tail -1)"
if [ -n "$LOG" ]; then
  echo "log mais recente: $LOG"
  echo "  falhas de auth nele: $(grep -c -E 'Not logged in|OAuth session expired|Failed to authenticate' "$LOG" 2>/dev/null)"
  echo "  ultimos ERROR/WARN:"
  grep -E '\[(ERROR|WARN)' "$LOG" 2>/dev/null | tail -5 | cut -c1-170 | sed 's/^/    /'
fi

# ---------------------------------------------------------------- 4. veredito
titulo "4. veredito"
ALVOS=""; ACAO=""
if [ "$HC" = ok ] && [ "$RC" = ok ]; then
  echo "SAUDAVEL — o worker responde. So falta o hook zerar o contador (passo 6)."
  ACAO=nenhuma
elif [ "$HC" = nao-sondei ] || [ "$RC" = nao-sondei ]; then
  echo "NAO SONDEI (curl ausente ou erro inesperado: $H / $R). Parei — sem dado nao mato nada."; exit 2
elif [ "$HC" = ok ] || [ "$HC" = erro-http ]; then
  VIDA=""; [ "$EH_WORKER" = 1 ] && VIDA="$(segundos_de_vida "$PID")"
  if [ -n "$VIDA" ] && [ "$VIDA" -lt 60 ]; then
    echo "SUBINDO — worker com ${VIDA}s de vida ainda nao pronto. Espere 30s e rode de novo."; exit 2
  fi
  echo "VIVO-MAS-NAO-PRONTO — atende HTTP mas nao fica pronto (health $H, readiness $R): init travou."
  ACAO=restart; [ "$EH_WORKER" = 1 ] && ALVOS="$PID"
elif [ "$HC" = recusada ] && [ "$EH_WORKER" = 0 ]; then
  echo "MORTO — nada escuta na porta e nenhum worker vivo no worker.pid."
  ACAO=start
elif [ "$HC" = recusada ]; then
  VIDA="$(segundos_de_vida "$PID")"
  if [ -n "$VIDA" ] && [ "$VIDA" -lt 60 ]; then
    echo "SUBINDO — worker com ${VIDA}s de vida ainda sem porta. Espere 30s e rode de novo."; exit 2
  fi
  if [ -n "$DONOS" ]; then
    echo "INCOERENTE — $HOST:$PORT recusou conexao, mas o lsof mostra quem escuta nessa porta ($DONOS). Endereco diferente do que eu sondei? Parei sem tocar em nada — me mande esta saida."; exit 2
  fi
  echo "VIVO-SEM-PORTA — worker-service.cjs vivo ha ${VIDA:-?}s e nada escutando: travado. Confirmando..."
  surdez_confirmada || { echo "Nao confirmou. Parei sem tocar em nada."; exit 2; }
  ACAO=matar; ALVOS="$PID"
elif [ "$HC" = surdo ]; then
  DO_CM=""; ALHEIOS=""
  for d in $DONOS; do if eh_do_claude_mem "$d"; then DO_CM="$DO_CM $d"; else ALHEIOS="$ALHEIOS $d"; fi; done
  if [ -n "$ALHEIOS" ]; then
    echo "PORTA DE OUTRO PROGRAMA —$ALHEIOS nao e do claude-mem. Nao mato. Troque CLAUDE_MEM_WORKER_PORT em $DATA/settings.json ou encerre esse programa."; exit 1
  fi
  [ "$EH_WORKER" = 1 ] && ALVOS="$PID"
  for d in $DO_CM; do [ "$d" = "$PID" ] || ALVOS="$ALVOS $d"; done
  if [ -z "$ALVOS" ]; then
    echo "SURDO sem dono identificavel (worker.pid morto e lsof nao mostrou quem escuta). Parei — me mande esta saida."; exit 2
  fi
  echo "SURDO — porta aberta e ninguem atende ($H). Mesmo caso de 05/09: o plugin NAO se recupera disso sozinho. Confirmando..."
  surdez_confirmada || { echo "Nao confirmou. Parei sem tocar em nada."; exit 2; }
  ACAO=matar
else
  echo "CASO NAO PREVISTO (health=$HC readiness=$RC vivo=$VIVO worker=$EH_WORKER donos=${DONOS:-?}). Parei — me mande esta saida."; exit 2
fi

if [ "$SO_OLHAR" = 1 ]; then echo "(--so-olhar: parei aqui; acao que eu tomaria = $ACAO${ALVOS:+ em$ALVOS})"; exit 0; fi
[ -n "$NODE" ] || { echo "Sem node no PATH — nao consigo prosseguir. Abra um terminal onde 'node -v' funcione."; exit 1; }
cd "$DATA" 2>/dev/null || cd "$HOME" || exit 1 # o daemon herda o cwd: nunca prender uma worktree

# ---------------------------------------------------------------- 5. recuperacao
if [ "$ACAO" != nenhuma ]; then titulo "5. recuperacao"; fi
if [ "$ACAO" = restart ]; then
  echo "restart pelo CLI do plugin (o worker atende HTTP, entao o shutdown gracioso deve funcionar)..."
  "$NODE" "$P/bun-runner.js" "$P/worker-service.cjs" restart 2>&1 | tail -3
  sleep 2
  if [ "$(classe "$(sonda /api/readiness 3)")" = ok ]; then
    ACAO=nenhuma
  elif [ -n "$ALVOS" ] && kill -0 "$ALVOS" 2>/dev/null; then
    echo "o restart nao resolveu e o mesmo pid segue vivo — vou derrubar a arvore."; ACAO=matar
  fi
fi
if [ "$ACAO" = matar ]; then
  LISTA=""
  for a in $ALVOS; do LISTA="$LISTA $(arvore "$a" | tr '\n' ' ')"; done
  # shellcheck disable=SC2086  # split intencional: lista de pids
  LISTA="$(printf '%s\n' $LISTA | sort -un | tr '\n' ' ')"
  echo "vou encerrar (alvo + descendentes/grupo):"
  for p in $LISTA; do ps -p "$p" -o pid=,ppid=,pgid=,etime=,pcpu=,command= 2>/dev/null | cut -c1-150 | sed 's/^/  /'; done
  confirma "Encerrar esses processos (SIGTERM; SIGKILL no que sobrar apos 5s)?" || { echo "Cancelado por voce. Nada foi tocado."; exit 1; }
  # shellcheck disable=SC2086  # split intencional: lista de pids
  kill -TERM $LISTA 2>/dev/null
  RESTO=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    RESTO=""; for p in $LISTA; do kill -0 "$p" 2>/dev/null && RESTO="$RESTO $p"; done
    [ -z "$RESTO" ] && break
    sleep 0.5
  done
  if [ -n "$RESTO" ]; then
    echo "sobraram:$RESTO -> SIGKILL"
    # shellcheck disable=SC2086  # split intencional: lista de pids
    kill -KILL $RESTO 2>/dev/null
    sleep 1
  fi
  LIVRE=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(classe "$(sonda /api/health 1)")" = recusada ] && { LIVRE=1; break; }
    sleep 0.5
  done
  if [ "$LIVRE" != 1 ]; then
    echo "A porta $PORT continua ocupada depois do kill. Parei — me mande esta saida (socket orfao do SO: reboot resolve)."; exit 1
  fi
  echo "porta $PORT livre."
  ACAO=start
fi
if [ "$ACAO" = start ]; then
  echo "start pelo CLI do plugin..."
  "$NODE" "$P/bun-runner.js" "$P/worker-service.cjs" start 2>&1 | tail -3
fi

# ---------------------------------------------------------------- 6. prova positiva
titulo "6. prova (o mesmo caminho do hook que te bloqueou)"
OK=0
for _ in $(seq 1 30); do
  if [ "$(classe "$(sonda /api/health 3)")" = ok ] && [ "$(classe "$(sonda /api/readiness 3)")" = ok ]; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != 1 ]; then
  echo "FALHOU: o worker nao ficou pronto em 30s. Ultimas linhas do log:"
  LOG="$(find "$DATA/logs" -maxdepth 1 -name 'claude-mem-*.log' 2>/dev/null | sort | tail -1)"
  [ -n "$LOG" ] && tail -15 "$LOG" | cut -c1-170 | sed 's/^/  /'
  exit 1
fi
echo "health 200 + readiness 200 (worker pid $(campo pid "$PIDF"))"
printf '{"session_id":"diag-reanimar","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}' "$HOME" |
  "$NODE" "$P/bun-runner.js" "$P/worker-service.cjs" hook claude-code context >/dev/null 2>&1
HRC=$?
echo "hook 'context' (so leitura): rc=$HRC"
CONT=""
if [ -f "$CONTF" ]; then
  CONT="$(campo consecutiveFailures "$CONTF")"
  echo "contador agora: ${CONT:-ilegivel}"
fi
if [ "$HRC" = 0 ] && { [ ! -f "$CONTF" ] || [ "$CONT" = 0 ]; }; then
  echo "RECUPERADO. Pode reenviar o prompt."; exit 0
fi
echo "worker pronto, mas o hook nao provou (rc=$HRC, contador=${CONT:-?}). Me mande esta saida."; exit 1
