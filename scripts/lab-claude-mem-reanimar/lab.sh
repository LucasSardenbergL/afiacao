#!/usr/bin/env bash
# lab.sh — laboratorio do scripts/claude-mem-reanimar.sh: um plugin falso (fake/) instalado num
# HOME descartavel por cenario, tudo num diretorio temporario (nada fica no repo).
#
# Uso: bash lab.sh [cenario...]      sem cenario = todos, em faixas paralelas
#   Quem roda no test:hooks/CI e o scripts/test-claude-mem-reanimar.sh: confere as ferramentas
#   antes, poe o subreaper.py no Linux e exige o marcador LAB-VERDE alem do exit 0.
#
# Portatil (Linux e macOS, bash 3.2+): o TTY da confirmacao vem do com_tty.py, o setsid do
# desanexa.py, e o "outro endereco" de loopback e ::1 (o 127.0.0.2 nao existe no macOS).
#
# Env: SCRIPT         alvo (a falsificacao aponta para a copia sabotada)
#      LAB_PORTA_BASE cada cenario usa BASE+k (37780). Duas execucoes SIMULTANEAS precisam de
#                     bases diferentes; cada cenario confere a propria porta e REPROVA se ela
#                     estiver ocupada (nunca "pula").
#      LAB_FAIXAS     cenarios em paralelo (4)
set -u
L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
F="$L/fake"
SCRIPT="${SCRIPT:-$L/../claude-mem-reanimar.sh}"
PY="${PY:-python3}"
BASE="${LAB_PORTA_BASE:-37780}"
FAIXAS="${LAB_FAIXAS:-4}"
case "$BASE$FAIXAS" in *[!0-9]*) echo "LAB-VERMELHO: LAB_PORTA_BASE/LAB_FAIXAS nao sao inteiros"; exit 1 ;; esac
tmpbase="${TMPDIR:-/tmp}"
RAIZ="$(mktemp -d "${tmpbase%/}/lab-reanimar.XXXXXX")" || { echo "LAB-VERMELHO: mktemp falhou"; exit 1; }
MARCA="LABMARK$$"
TETO_RODA=90 # s por execucao do script: o com_tty.py mata e sai 124 se estourar

limpa() {
  pkill -KILL -f "$RAIZ/" 2>/dev/null
  pkill -KILL -f "$MARCA-" 2>/dev/null
  case "$RAIZ" in */lab-reanimar.?*) rm -rf "$RAIZ" ;; esac
}
trap limpa EXIT

# Tempos do script em MODO TESTE (ver o cabecalho dele). A idade minima e POR CENARIO, para nao
# haver corrida de relogio em nenhum sentido: os que exigem worker VELHO usam IDADE (2 s) e
# esperam o worker passar dela (`envelhece`); os que exigem worker JOVEM rodam com IDADE_JOVEM
# (600 s), que nenhuma lentidao faz um worker de segundos atingir. Medido em 2026-09-25: com uma
# idade unica de 8 s, a M2 sob carga levou 9 s ate o veredito e o "jovem" foi derrubado — o
# script estava certo; o lab e que apostava no relogio.
IDADE=2
IDADE_JOVEM=600
# DIAGNOSTICO 2 s: folga para worker SAUDAVEL responder sob carga (1 s beirava o limite)
export REANIMAR_TESTE_IDADE_MIN_S="$IDADE" REANIMAR_TESTE_SONDA_S=1 REANIMAR_TESTE_ESPERA_S=0 \
  REANIMAR_TESTE_PROVA_S=5 REANIMAR_TESTE_DIAGNOSTICO_S=2
export LAB_START_TENTATIVAS=12 # o `start` falso desiste em 3 s (o real, em ~10 s)

FALHAS=0; PASSOU=0
H=""; DATA=""; CACHE=""; PORT=""; OUT=""; RC=""

usa() { # $1 = nome do cenario, $2 = deslocamento da porta
  H="$RAIZ/home-$1"; DATA="$H/.claude-mem"; CACHE="$H/.claude/plugins/cache/thedotmack/claude-mem"
  PORT=$((BASE + $2)); OUT="$RAIZ/saida-$1.txt"
}
ok() { PASSOU=$((PASSOU + 1)); echo "  ok    $1"; }
nok() { FALHAS=$((FALHAS + 1)); echo "  FALHA $1"; }
mata_lab() { pkill -KILL -f "$H/" 2>/dev/null; pkill -KILL -f "$MARCA-$PORT" 2>/dev/null; sleep 0.3; }
porta_livre() { # SO_REUSEADDR como o node, senao um TIME_WAIT do cenario anterior reprovaria
  "$PY" -c 'import socket,sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)' "$PORT"
}
tem_ipv6() { "$PY" -c 'import socket; s = socket.socket(socket.AF_INET6); s.bind(("::1", 0))' 2>/dev/null; }
# espera_ate <o que> <teto_s> <comando...> — polling de 0,1 s no lugar de `sleep` fixo (que aposta
# na velocidade da maquina); estourou o teto = DIZ e reprova, nunca segue como se tivesse dado
espera_ate() {
  local oque="$1" teto="$2" n=0
  shift 2
  while ! "$@" >/dev/null 2>&1; do
    n=$((n + 1))
    if [ "$n" -gt $((teto * 10)) ]; then nok "$oque nao aconteceu em ${teto}s — cenario NAO rodou"; return 1; fi
    sleep 0.1
  done
}
existe_proc() { [ -n "$(filho_de "$1")" ]; }
escutando() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t; }
sobe_daemon() { # $1 = modo
  printf '%s' "$1" >"$DATA/.lab-mode"
  # disown: o daemon e desanexado de proposito; sem isto o bash 3.2 o guarda na tabela de jobs e
  # anuncia "Killed: 9" quando a limpeza final o mata
  (cd "$DATA" && exec env HOME="$H" "$PY" "$L/desanexa.py" node "$CACHE/13.15.3/scripts/worker-service.cjs" --daemon >/dev/null 2>&1) &
  disown
  espera_ate "o worker falso ($1) gravar o worker.pid" 20 test -f "$DATA/worker.pid" || return 1
  sleep 0.5
}
prepara() { # $1 = modo inicial do daemon | nenhum. Porta ocupada = o cenario NAO roda = reprova
  mata_lab
  if ! porta_livre; then nok "porta $PORT OCUPADA por outro processo — cenario NAO rodou (outro lab ao mesmo tempo?)"; return 1; fi
  rm -rf "$H"; mkdir -p "$DATA/state" "$DATA/logs" "$CACHE"
  # o fake usa require(); se o TMPDIR cair dentro de um repo "type": "module", isto o mantem CommonJS
  printf '{"type":"commonjs"}\n' >"$H/package.json"
  mkdir -p "$CACHE/13.15.3/scripts"; cp "$F/bun-runner.js" "$F/worker-service.cjs" "$CACHE/13.15.3/scripts/"
  # isca: 13.9.0 vence se a ordenacao for lexicografica
  mkdir -p "$CACHE/13.9.0/scripts"; cp "$F/bun-runner.js" "$CACHE/13.9.0/scripts/"; cp "$F/decoy-worker.cjs" "$CACHE/13.9.0/scripts/worker-service.cjs"
  # isca: 13.20.0 e maior mas esta orfa
  mkdir -p "$CACHE/13.20.0/scripts"; cp "$F/bun-runner.js" "$CACHE/13.20.0/scripts/"; cp "$F/decoy-worker.cjs" "$CACHE/13.20.0/scripts/worker-service.cjs"; touch "$CACHE/13.20.0/.orphaned_at"
  if [ -n "${LAB_HOST:-}" ]; then
    printf '{\n  "CLAUDE_MEM_WORKER_PORT": "%s",\n  "CLAUDE_MEM_WORKER_HOST": "%s"\n}\n' "$PORT" "$LAB_HOST" >"$DATA/settings.json"
  else
    printf '{\n  "CLAUDE_MEM_WORKER_PORT": "%s"\n}\n' "$PORT" >"$DATA/settings.json"
  fi
  printf '{"consecutiveFailures":5,"lastFailureAt":1}' >"$DATA/state/hook-failures.json"
  sqlite3 "$DATA/claude-mem.db" "create table observations(id integer primary key, created_at text, created_at_epoch integer); insert into observations(created_at,created_at_epoch) values ('2026-08-13T09:00:00.000Z', 1);"
  printf '[2026-09-24 11:00:00] [ERROR] [SDK] Not logged in · Please run /login\n' >"$DATA/logs/claude-mem-2026-09-24.log"
  [ "$1" = nenhum ] || sobe_daemon "$1"
}
roda() { # $1 = resposta ao prompt; demais = args do script. SEM_TESTE=1 roda com os tempos REAIS
  local resp="$1"
  shift
  local sem=""
  [ -n "${SEM_TESTE:-}" ] && sem="-u REANIMAR_TESTE_IDADE_MIN_S -u REANIMAR_TESTE_SONDA_S -u REANIMAR_TESTE_ESPERA_S -u REANIMAR_TESTE_PROVA_S -u REANIMAR_TESTE_DIAGNOSTICO_S"
  # shellcheck disable=SC2086  # split intencional: $sem e zero ou dez palavras de `env -u`
  printf '%s\n' "$resp" | env -u CLAUDE_MEM_DATA_DIR -u CLAUDE_CONFIG_DIR -u CLAUDE_MEM_WORKER_PORT -u CLAUDE_MEM_WORKER_HOST $sem \
    HOME="$H" SHELL=/bin/bash PATH="${LAB_PATH:-$PATH}" LAB_START_MODE="${LAB_START_MODE:-}" LAB_HOOK_FAIL="${LAB_HOOK_FAIL:-}" \
    "$PY" "$L/com_tty.py" "$TETO_RODA" bash "$SCRIPT" "$@" >"$OUT.raw" 2>&1
  RC=$?
  tr -d '\r' <"$OUT.raw" >"$OUT"
}
rc_eh() { if [ "$RC" = "$1" ]; then ok "rc=$1"; else nok "rc esperado $1, veio $RC"; fi; }
contem() { if grep -qF -- "$1" "$OUT"; then ok "diz: $1"; else nok "NAO diz: $1"; fi; }
nao_contem() { if grep -qF -- "$1" "$OUT"; then nok "diz (nao devia): $1"; else ok "nao diz: $1"; fi; }
estado() { ps -p "$1" -o stat= 2>/dev/null | tr -d ' '; }
vivo() { local s; s="$(estado "$1")"; case "$s" in "" | Z*) nok "pid $1 ($2) MORREU (nao devia)" ;; *) ok "pid $1 ($2) segue vivo" ;; esac; }
morto() { local s; s="$(estado "$1")"; case "$s" in "" | Z*) ok "pid $1 ($2) morreu" ;; *) nok "pid $1 ($2) segue VIVO ($s)" ;; esac; }
filho_de() { ps -A -o pid=,args= | awk -v m="$1" 'index($0, m) && !/awk/ {print $1; exit}'; }
contador() { sed -n 's/.*"consecutiveFailures":\([0-9]*\).*/\1/p' "$DATA/state/hook-failures.json"; }
pid_do_arquivo() { sed -n 's/.*"pid"[^0-9]*\([0-9]*\).*/\1/p' "$DATA/worker.pid" 2>/dev/null | head -1; }
contador_zerado() { if [ "$(contador)" = 0 ]; then ok "contador zerado"; else nok "contador=$(contador)"; fi; }
vida() { # etime ([[dd-]hh:]mm:ss) -> segundos; vazio se o processo nao existe
  local e d=0 h=0 m=0 s=0 a b c
  e="$(ps -p "$1" -o etime= 2>/dev/null | tr -d ' ')"
  [ -n "$e" ] || return 0
  case "$e" in *-*) d="${e%%-*}"; e="${e#*-}" ;; esac
  IFS=: read -r a b c <<<"$e"
  if [ -n "${c:-}" ]; then h=$a; m=$b; s=$c; else m=$a; s=${b:-0}; fi
  echo $((10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}
envelhece() { # espera o worker passar da idade minima; teto IDADE+15 s, e diz se nao conseguiu
  local w="$1" v
  for _ in $(seq 1 $((IDADE + 15))); do
    v="$(vida "$w")"
    if [ -z "$v" ]; then nok "worker '$w' sumiu antes de envelhecer — cenario NAO rodou"; return 1; fi
    [ "$v" -gt "$IDADE" ] && return 0
    sleep 1
  done
  nok "worker $w nao passou de ${IDADE}s no teto — cenario NAO rodou"; return 1
}
# Os cenarios que exigem worker VELHO (> IDADE) sobem o worker ja no inicio (preaquece): ele
# envelhece enquanto os outros rodam. Rodado sozinho, o cenario sobe o proprio e espera.
aquecido() { grep -qx "$1" "$RAIZ/aquecidos" 2>/dev/null; }
preaquece() { # silencioso e sem contar: se falhar aqui, o proprio cenario prepara de novo e reprova
  local c salvo="$FALHAS"
  : >"$RAIZ/aquecidos"
  for c in "$@"; do
    case "$c" in
      c_naopronto) usa naopronto 10; prepara naopronto >/dev/null && echo naopronto >>"$RAIZ/aquecidos" ;;
      c_teimoso) usa teimoso 11; prepara naopronto-teimoso >/dev/null && echo teimoso >>"$RAIZ/aquecidos" ;;
      c_semporta) usa semporta 12; prepara semporta >/dev/null && echo semporta >>"$RAIZ/aquecidos" ;;
      c_incoerente) tem_ipv6 && usa incoerente 17 && prepara sao-outro-endereco >/dev/null && echo incoerente >>"$RAIZ/aquecidos" ;;
    esac
  done
  FALHAS="$salvo"
}

# ------------------------------------------------------------------------------------ cenarios
c_saudavel() { # SEM os tempos de teste: prova que os defaults valem (e que nao ha aviso MODO TESTE)
  echo "[saudavel, tempos reais]"; usa saudavel 1; prepara sao || return 0
  local w; w="$(pid_do_arquivo)"
  SEM_TESTE=1 roda n
  rc_eh 0; nao_contem "MODO TESTE"; contem "versao ativa: 13.15.3"; nao_contem "DECOY"; contem "ATENCAO: < 13.24.18"
  contem "SAUDAVEL"; contem "RECUPERADO"; vivo "$w" worker
  contem "ultima observacao gravada: 2026-08-13T09:00:00.000Z"; contem "falhas de auth nele: 1"
  contador_zerado
  if grep -q diag-reanimar "$DATA/.lab-hook-calls" 2>/dev/null; then ok "hook context foi chamado"; else nok "hook context NAO chamado"; fi
}
c_morto() {
  echo "[morto]"; usa morto 2; prepara nenhum || return 0
  printf '{\n  "pid": 999999,\n  "port": %s\n}\n' "$PORT" >"$DATA/worker.pid"
  roda n
  rc_eh 0; contem "MODO TESTE: tempos por env"; contem "MORTO — nada escuta"; contem "RECUPERADO"; nao_contem "vou encerrar"
  local w; w="$(pid_do_arquivo)"
  if [ "$w" != 999999 ]; then vivo "$w" "worker novo"; else nok "worker.pid nao mudou"; fi
  contador_zerado
}
c_reciclado() {
  echo "[pid reciclado]"; usa reciclado 3; prepara nenhum || return 0
  "$PY" -c "import time; time.sleep(1000)" "$MARCA-$PORT" >/dev/null 2>&1 &
  disown
  espera_ate "o processo alheio subir" 10 existe_proc "$MARCA-$PORT" || return 0
  local alheio; alheio="$(filho_de "$MARCA-$PORT")"
  printf '{\n  "pid": %s,\n  "port": %s\n}\n' "$alheio" "$PORT" >"$DATA/worker.pid"
  roda n
  rc_eh 0; contem "numero foi reciclado"; contem "MORTO — nada escuta"; contem "RECUPERADO"; vivo "$alheio" "processo alheio com pid reciclado"
}
monta_surdo() { # sobe o surdo e confere os 3 processos da arvore; ecoa "worker chroma sdk"
  local w c k
  w="$(pid_do_arquivo)"; c="$(filho_de "$DATA/chroma")"; k="$(filho_de "stream-json $DATA")"
  if [ -n "$w" ] && [ -n "$c" ] && [ -n "$k" ]; then ok "montei worker=$w chroma=$c sdk=$k"; else nok "montagem incompleta w=$w c=$c k=$k"; fi
  ARV="$w $c $k"
}
c_surdo_sim() {
  echo "[surdo + confirma]"; usa surdo 4; prepara surdo || return 0
  monta_surdo
  local w c k; read -r w c k <<<"$ARV"
  roda s
  rc_eh 0; contem "SURDO — porta aberta"; contem "sonda 3: surdo"; contem "vou encerrar"; contem "sobraram"; contem "porta $PORT livre"; contem "RECUPERADO"
  morto "$w" "worker surdo"; morto "$c" "chroma (mesmo pgid)"; morto "$k" "claude SDK (pgid proprio, ignora TERM)"
  local n; n="$(pid_do_arquivo)"
  if [ "$n" != "$w" ]; then vivo "$n" "worker novo"; else nok "worker.pid nao mudou"; fi
}
c_surdo_nao() {
  echo "[surdo + cancela]"; usa surdo-nao 5; prepara surdo || return 0
  monta_surdo
  local w c k; read -r w c k <<<"$ARV"
  roda n
  rc_eh 1; contem "Cancelado"; nao_contem "RECUPERADO"; vivo "$w" worker; vivo "$c" chroma; vivo "$k" sdk
}
c_so_olhar() {
  echo "[surdo --so-olhar]"; usa olhar 6; prepara surdo || return 0
  monta_surdo
  local w c k; read -r w c k <<<"$ARV"
  roda s --so-olhar
  rc_eh 0; contem "acao que eu tomaria = matar"; nao_contem "vou encerrar"; nao_contem "RECUPERADO"
  vivo "$w" worker; vivo "$c" chroma; vivo "$k" sdk
  if [ ! -f "$DATA/.lab-hook-calls" ]; then ok "--so-olhar nao chamou hook"; else nok "--so-olhar chamou hook"; fi
}
c_alheio() {
  echo "[porta de outro programa]"; usa alheio 7; prepara nenhum || return 0
  "$PY" -c "import socket,time,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(0); time.sleep(1000)" "$PORT" "$MARCA-$PORT" >/dev/null 2>&1 &
  disown
  espera_ate "o programa alheio escutar na porta $PORT" 10 escutando "$PORT" || return 0
  local a; a="$(filho_de "$MARCA-$PORT")"
  roda s
  rc_eh 1; contem "PORTA DE OUTRO PROGRAMA"; nao_contem "vou encerrar"; vivo "$a" "programa alheio"
}
c_nao_sondei() {
  echo "[curl quebrado]"; usa nao-sondei 8; prepara sao || return 0
  local stub="$RAIZ/stub-curl"
  mkdir -p "$stub"; printf '#!/bin/sh\nexit 6\n' >"$stub/curl"; chmod +x "$stub/curl"
  LAB_PATH="$stub:$PATH" roda s
  rc_eh 2; contem "NAO SONDEI"; nao_contem "vou encerrar"
}
c_start_falha() {
  echo "[start que nao sobe]"; usa start-falha 9; prepara nenhum || return 0
  LAB_START_MODE=semporta roda n
  rc_eh 1; contem "MORTO"; contem "FALHOU"; nao_contem "RECUPERADO"
}
# os tres abaixo precisam de worker com mais que IDADE s de vida (senao o script diz SUBINDO, e certo)
c_naopronto() {
  echo "[nao-pronto -> restart]"; usa naopronto 10
  aquecido naopronto || prepara naopronto || return 0
  local w; w="$(pid_do_arquivo)"; envelhece "$w" || return 0
  roda n
  rc_eh 0; contem "VIVO-MAS-NAO-PRONTO"; nao_contem "vou encerrar"; contem "RECUPERADO"; morto "$w" "worker nao-pronto"
}
c_teimoso() {
  echo "[nao-pronto teimoso -> restart falha -> derruba]"; usa teimoso 11
  aquecido teimoso || prepara naopronto-teimoso || return 0
  local w; w="$(pid_do_arquivo)"; envelhece "$w" || return 0
  roda s
  rc_eh 0; contem "vou derrubar a arvore"; contem "vou encerrar"; contem "RECUPERADO"; morto "$w" "worker teimoso"
}
c_semporta() {
  echo "[vivo sem porta]"; usa semporta 12
  aquecido semporta || prepara semporta || return 0
  local w; w="$(pid_do_arquivo)"; envelhece "$w" || return 0
  roda s
  rc_eh 0; contem "VIVO-SEM-PORTA"; contem "sonda 3: recusada"; contem "RECUPERADO"; morto "$w" "worker sem porta"
}
# worker jovem (< IDADE) nunca e derrubado nem reiniciado — nos dois ramos que checam idade
c_subindo() {
  echo "[subindo: worker jovem intocado]"
  usa subindo-a 13; prepara naopronto || return 0
  local w1; w1="$(pid_do_arquivo)"
  REANIMAR_TESTE_IDADE_MIN_S="$IDADE_JOVEM" roda s
  rc_eh 2; contem "SUBINDO — worker com"; nao_contem "vou encerrar"; nao_contem "restart pelo CLI"; vivo "$w1" "worker jovem nao-pronto"
  usa subindo-b 14; prepara semporta || return 0
  local w2; w2="$(pid_do_arquivo)"
  REANIMAR_TESTE_IDADE_MIN_S="$IDADE_JOVEM" roda s
  rc_eh 2; contem "SUBINDO — worker com"; nao_contem "vou encerrar"; vivo "$w2" "worker jovem sem porta"
}
# worker saudavel mas o hook falha: a prova NAO pode dizer RECUPERADO
c_hook_falha() {
  echo "[hook falha com worker saudavel]"; usa hook-falha 15; prepara sao || return 0
  LAB_HOOK_FAIL=1 roda n
  rc_eh 1; contem "o hook nao provou"; nao_contem "RECUPERADO"
}
# host configurado em settings.json: o script sonda o MESMO host que o hook usa (::1 = colchetes)
c_host_config() {
  echo "[host configurado ::1]"; usa host-config 16
  tem_ipv6 || { nok "loopback IPv6 (::1) indisponivel — cenario NAO rodou (reprova, nao pula)"; return 0; }
  LAB_HOST=::1 prepara sao || return 0
  local w; w="$(pid_do_arquivo)"
  roda n
  rc_eh 0; contem "endereco do hook: [::1]:$PORT"; contem "SAUDAVEL"; contem "RECUPERADO"; vivo "$w" "worker em ::1"
}
# worker saudavel escutando em OUTRO endereco (sonda recusada, lsof ve o dono): nunca matar
c_incoerente() {
  echo "[incoerente: recusado no host sondado, mas ha dono na porta]"; usa incoerente 17
  tem_ipv6 || { nok "loopback IPv6 (::1) indisponivel — cenario NAO rodou (reprova, nao pula)"; return 0; }
  aquecido incoerente || prepara sao-outro-endereco || return 0
  local w; w="$(pid_do_arquivo)"; envelhece "$w" || return 0
  roda s
  rc_eh 2; contem "INCOERENTE"; nao_contem "vou encerrar"; nao_contem "VIVO-SEM-PORTA"; vivo "$w" "worker saudavel em outro endereco"
}
# override de tempo quebrado = PARA antes de tudo: nunca vira fail-OPEN num script que mata
c_tempo_invalido() {
  echo "[tempo de teste invalido]"; usa tempo-invalido 18; prepara naopronto || return 0
  local w; w="$(pid_do_arquivo)"
  REANIMAR_TESTE_IDADE_MIN_S=abc roda s
  rc_eh 2; contem "PAREI: REANIMAR_TESTE_IDADE_MIN_S='abc'"; nao_contem "restart pelo CLI"; nao_contem "vou encerrar"; vivo "$w" "worker jovem"
  REANIMAR_TESTE_SONDA_S=0 roda s
  rc_eh 2; contem "PAREI: REANIMAR_TESTE_SONDA_S='0'"; nao_contem "restart pelo CLI"; vivo "$w" "worker jovem"
}

# ------------------------------------------------------------------------------------ execucao
# Ordem de custo (os lentos primeiro, os que exigem worker velho por ultimo): distribuidos em
# FAIXAS por rodizio. Cada cenario roda num subshell com contagem propria e termina com a linha
# CONTAGEM — sem ela, o cenario NAO terminou e conta como falha (evidencia positiva, nao ausencia).
TODOS="c_surdo_sim c_surdo_nao c_so_olhar c_alheio c_start_falha c_subindo c_morto c_reciclado c_hook_falha c_host_config c_tempo_invalido c_saudavel c_nao_sondei c_teimoso c_naopronto c_semporta c_incoerente"
CENARIOS="${*:-$TODOS}"
for c in $CENARIOS; do
  case " $TODOS " in *" $c "*) ;; *) echo "cenario desconhecido: $c"; echo "LAB-VERMELHO"; exit 1 ;; esac
done
# shellcheck disable=SC2086  # split intencional: lista de cenarios
preaquece $CENARIOS
faixa() { # roda, em sequencia, os cenarios da faixa $1 (rodizio sobre $CENARIOS)
  local i=0 c
  for c in $CENARIOS; do
    if [ $((i % FAIXAS)) -eq "$1" ]; then
      (
        trap - EXIT
        FALHAS=0; PASSOU=0; OUT=""
        "$c"
        if [ "$FALHAS" -gt 0 ] && [ -f "$OUT" ]; then # para o log do CI: o que o script disse
          echo "  --- fim da saida do script ($(basename "$OUT")) ---"
          tail -25 "$OUT" | sed 's/^/  | /'
        fi
        echo "CONTAGEM $PASSOU $FALHAS"
      ) >"$RAIZ/res-$c.txt" 2>&1
    fi
    i=$((i + 1))
  done
}
f=0
while [ "$f" -lt "$FAIXAS" ]; do faixa "$f" & f=$((f + 1)); done
wait
TOTAL_OK=0; TOTAL_FALHAS=0 # os contadores de cada cenario sao locais ao subshell dele, de proposito
for c in $CENARIOS; do
  r="$RAIZ/res-$c.txt"
  grep -v '^CONTAGEM ' "$r" 2>/dev/null
  linha="$(grep '^CONTAGEM ' "$r" 2>/dev/null | tail -1)"
  if [ -z "$linha" ]; then
    echo "  FALHA $c NAO terminou (sem a linha CONTAGEM) — ausencia de dado, nao verde"; TOTAL_FALHAS=$((TOTAL_FALHAS + 1)); continue
  fi
  read -r _ p fl <<<"$linha"
  TOTAL_OK=$((TOTAL_OK + p)); TOTAL_FALHAS=$((TOTAL_FALHAS + fl))
done
echo
echo "RESULTADO: $TOTAL_OK ok · $TOTAL_FALHAS falha(s)"
if [ "$TOTAL_FALHAS" = 0 ]; then echo "LAB-VERDE"; else echo "LAB-VERMELHO"; fi
[ "$TOTAL_FALHAS" = 0 ]
