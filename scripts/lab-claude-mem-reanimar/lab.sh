#!/usr/bin/env bash
# Laboratorio do claude-mem-reanimar.sh — roda SOB subreaper.py (reaper igual ao launchd).
# Uso: python3 subreaper.py bash lab.sh [cenario...]   (sem cenario = todos)
set -u
L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
F="$L/fake"
SCRIPT="${SCRIPT:-$L/../claude-mem-reanimar.sh}"
FALHAS=0; PASSOU=0
H=""; DATA=""; CACHE=""; PORT=""; OUT=""; RC=""

usa() { # $1 = nome do lab, $2 = porta
  H="$L/home-$1"; DATA="$H/.claude-mem"; CACHE="$H/.claude/plugins/cache/thedotmack/claude-mem"; PORT="$2"; OUT="$L/saida-$1.txt"
}
mata_lab() { pkill -KILL -f "$H/" 2>/dev/null; pkill -KILL -f "LABMARK-$PORT" 2>/dev/null; sleep 0.3; }
sobe_daemon() { # $1 = modo
  printf '%s' "$1" >"$DATA/.lab-mode"
  (cd "$DATA" && HOME="$H" setsid node "$CACHE/13.15.3/scripts/worker-service.cjs" --daemon >/dev/null 2>&1 &)
  for _ in $(seq 1 50); do [ -f "$DATA/worker.pid" ] && break; sleep 0.1; done
  sleep 0.5
}
prepara() { # $1 = modo inicial do daemon | nenhum
  mata_lab
  rm -rf "$H"; mkdir -p "$DATA/state" "$DATA/logs" "$CACHE"
  # o lab vive dentro do repo ("type": "module"): o fake usa require(), entao cada HOME declara CommonJS
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
roda() { # $1 = resposta ao prompt; demais = args do script
  local resp="$1"; shift
  printf '%s\n' "$resp" | env -u CLAUDE_MEM_DATA_DIR -u CLAUDE_CONFIG_DIR -u CLAUDE_MEM_WORKER_PORT \
    HOME="$H" SHELL=/bin/bash PATH="${LAB_PATH:-$PATH}" LAB_START_MODE="${LAB_START_MODE:-}" LAB_HOOK_FAIL="${LAB_HOOK_FAIL:-}" \
    script -qec "bash '$SCRIPT' $*" /dev/null >"$OUT.raw" 2>&1
  RC=$?
  tr -d '\r' <"$OUT.raw" >"$OUT"
}
ok() { PASSOU=$((PASSOU + 1)); echo "  ok    $1"; }
nok() { FALHAS=$((FALHAS + 1)); echo "  FALHA $1"; }
rc_eh() { if [ "$RC" = "$1" ]; then ok "rc=$1"; else nok "rc esperado $1, veio $RC"; fi; }
contem() { if grep -qF -- "$1" "$OUT"; then ok "diz: $1"; else nok "NAO diz: $1"; fi; }
nao_contem() { if grep -qF -- "$1" "$OUT"; then nok "diz (nao devia): $1"; else ok "nao diz: $1"; fi; }
estado() { ps -p "$1" -o stat= 2>/dev/null | tr -d ' '; }
vivo() { local s; s="$(estado "$1")"; case "$s" in "" | Z*) nok "pid $1 ($2) MORREU (nao devia)" ;; *) ok "pid $1 ($2) segue vivo" ;; esac; }
morto() { local s; s="$(estado "$1")"; case "$s" in "" | Z*) ok "pid $1 ($2) morreu" ;; *) nok "pid $1 ($2) segue VIVO ($s)" ;; esac; }
filho_de() { ps -A -o pid=,args= | awk -v m="$1" 'index($0, m) && !/awk/ {print $1; exit}'; }
contador() { sed -n 's/.*"consecutiveFailures":\([0-9]*\).*/\1/p' "$DATA/state/hook-failures.json"; }
pid_do_arquivo() { sed -n 's/.*"pid"[^0-9]*\([0-9]*\).*/\1/p' "$DATA/worker.pid" | head -1; }

c_saudavel() {
  echo "[saudavel]"; usa saudavel 37781; prepara sao; local w; w="$(pid_do_arquivo)"
  roda n
  rc_eh 0; contem "versao ativa: 13.15.3"; nao_contem "DECOY"; contem "ATENCAO: < 13.24.18"
  contem "SAUDAVEL"; contem "RECUPERADO"; vivo "$w" worker
  contem "ultima observacao gravada: 2026-08-13T09:00:00.000Z"; contem "falhas de auth nele: 1"
  [ "$(contador)" = 0 ] && ok "contador zerado" || nok "contador=$(contador)"
  grep -q diag-reanimar "$DATA/.lab-hook-calls" && ok "hook context foi chamado" || nok "hook context NAO chamado"
}
c_morto() {
  echo "[morto]"; usa morto 37782; prepara nenhum
  printf '{\n  "pid": 999999,\n  "port": %s\n}\n' "$PORT" >"$DATA/worker.pid"
  roda n
  rc_eh 0; contem "MORTO — nada escuta"; contem "RECUPERADO"; nao_contem "vou encerrar"
  local w; w="$(pid_do_arquivo)"; [ "$w" != 999999 ] && vivo "$w" "worker novo" || nok "worker.pid nao mudou"
  [ "$(contador)" = 0 ] && ok "contador zerado" || nok "contador=$(contador)"
}
c_reciclado() {
  echo "[pid reciclado]"; usa reciclado 37783; prepara nenhum
  setsid python3 -c "import time; time.sleep(1000)" "LABMARK-$PORT" >/dev/null 2>&1 &
  sleep 0.3; local alheio; alheio="$(filho_de "LABMARK-$PORT")"
  printf '{\n  "pid": %s,\n  "port": %s\n}\n' "$alheio" "$PORT" >"$DATA/worker.pid"
  roda n
  rc_eh 0; contem "numero foi reciclado"; contem "MORTO — nada escuta"; contem "RECUPERADO"; vivo "$alheio" "processo alheio com pid reciclado"
}
c_surdo_sim() {
  echo "[surdo + confirma]"; usa surdo 37784; prepara surdo
  local w c k; w="$(pid_do_arquivo)"; c="$(filho_de "$DATA/chroma")"; k="$(filho_de "stream-json $DATA")"
  [ -n "$w" ] && [ -n "$c" ] && [ -n "$k" ] && ok "montei worker=$w chroma=$c sdk=$k" || nok "montagem incompleta w=$w c=$c k=$k"
  roda s
  rc_eh 0; contem "SURDO — porta aberta"; contem "sonda 3: surdo"; contem "vou encerrar"; contem "sobraram"; contem "porta $PORT livre"; contem "RECUPERADO"
  morto "$w" "worker surdo"; morto "$c" "chroma (mesmo pgid)"; morto "$k" "claude SDK (pgid proprio, ignora TERM)"
  local n; n="$(pid_do_arquivo)"; [ "$n" != "$w" ] && vivo "$n" "worker novo" || nok "worker.pid nao mudou"
}
c_surdo_nao() {
  echo "[surdo + cancela]"; usa surdo-nao 37785; prepara surdo
  local w c k; w="$(pid_do_arquivo)"; c="$(filho_de "$DATA/chroma")"; k="$(filho_de "stream-json $DATA")"
  roda n
  rc_eh 1; contem "Cancelado"; nao_contem "RECUPERADO"; vivo "$w" worker; vivo "$c" chroma; vivo "$k" sdk
}
c_so_olhar() {
  echo "[surdo --so-olhar]"; usa olhar 37786; prepara surdo
  local w c k; w="$(pid_do_arquivo)"; c="$(filho_de "$DATA/chroma")"; k="$(filho_de "stream-json $DATA")"
  roda s --so-olhar
  rc_eh 0; contem "acao que eu tomaria = matar"; nao_contem "vou encerrar"; nao_contem "RECUPERADO"
  vivo "$w" worker; vivo "$c" chroma; vivo "$k" sdk
  [ ! -f "$DATA/.lab-hook-calls" ] && ok "--so-olhar nao chamou hook" || nok "--so-olhar chamou hook"
}
c_alheio() {
  echo "[porta de outro programa]"; usa alheio 37787; prepara nenhum
  setsid python3 -c "import socket,time,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(0); time.sleep(1000)" "$PORT" "LABMARK-$PORT" >/dev/null 2>&1 &
  sleep 0.5; local a; a="$(filho_de "LABMARK-$PORT")"
  roda s
  rc_eh 1; contem "PORTA DE OUTRO PROGRAMA"; nao_contem "vou encerrar"; vivo "$a" "programa alheio"
}
c_nao_sondei() {
  echo "[curl quebrado]"; usa nao-sondei 37788; prepara sao
  mkdir -p "$L/stub"; printf '#!/bin/sh\nexit 6\n' >"$L/stub/curl"; chmod +x "$L/stub/curl"
  LAB_PATH="$L/stub:$PATH" roda s
  rc_eh 2; contem "NAO SONDEI"; nao_contem "vou encerrar"
}
c_start_falha() {
  echo "[start que nao sobe]"; usa start-falha 37789; prepara nenhum
  LAB_START_MODE=semporta roda n
  rc_eh 1; contem "MORTO"; contem "FALHOU"; nao_contem "RECUPERADO"
}
# os tres abaixo precisam de >60s de vida do worker (senao o script diz SUBINDO, corretamente)
c_lentos() {
  echo "[subindo / nao-pronto / teimoso / sem-porta — preparando e esperando 62s]"
  usa naopronto 37790; prepara naopronto
  roda n; echo " (subindo)"; rc_eh 2; contem "SUBINDO"
  usa teimoso 37791; prepara naopronto-teimoso
  usa semporta 37792; prepara semporta
  sleep 62
  echo "[nao-pronto -> restart]"; usa naopronto 37790; local w; w="$(pid_do_arquivo)"
  roda n
  rc_eh 0; contem "VIVO-MAS-NAO-PRONTO"; nao_contem "vou encerrar"; contem "RECUPERADO"; morto "$w" "worker nao-pronto"
  echo "[nao-pronto teimoso -> restart falha -> derruba]"; usa teimoso 37791; w="$(pid_do_arquivo)"
  roda s
  rc_eh 0; contem "vou derrubar a arvore"; contem "vou encerrar"; contem "RECUPERADO"; morto "$w" "worker teimoso"
  echo "[vivo sem porta]"; usa semporta 37792; w="$(pid_do_arquivo)"
  roda s
  rc_eh 0; contem "VIVO-SEM-PORTA"; contem "sonda 3: recusada"; contem "RECUPERADO"; morto "$w" "worker sem porta"
}
# worker jovem (<60s) nunca e derrubado nem reiniciado — nos dois ramos que checam idade
c_subindo() {
  echo "[subindo: worker jovem intocado]"
  usa subindo-a 37793; prepara naopronto; local w1; w1="$(pid_do_arquivo)"
  roda s
  rc_eh 2; contem "SUBINDO — worker com"; nao_contem "vou encerrar"; nao_contem "restart pelo CLI"; vivo "$w1" "worker jovem nao-pronto"
  usa subindo-b 37794; prepara semporta; local w2; w2="$(pid_do_arquivo)"
  roda s
  rc_eh 2; contem "SUBINDO — worker com"; nao_contem "vou encerrar"; vivo "$w2" "worker jovem sem porta"
}
# worker saudavel mas o hook falha: a prova NAO pode dizer RECUPERADO
c_hook_falha() {
  echo "[hook falha com worker saudavel]"
  usa hook-falha 37795; prepara sao
  LAB_HOOK_FAIL=1 roda n
  rc_eh 1; contem "o hook nao provou"; nao_contem "RECUPERADO"
}

# host configurado em settings.json: o script tem de sondar o MESMO host que o hook usa
c_host_config() {
  echo "[host configurado 127.0.0.2]"
  usa host-config 37796; LAB_HOST=127.0.0.2 prepara sao; local w; w="$(pid_do_arquivo)"
  roda n
  rc_eh 0; contem "endereco do hook: 127.0.0.2:37796"; contem "SAUDAVEL"; contem "RECUPERADO"; vivo "$w" "worker em 127.0.0.2"
}
# worker saudavel escutando em OUTRO endereco (sonda recusada, lsof ve o dono): nunca matar
c_incoerente() {
  echo "[incoerente: recusado no host sondado, mas ha dono na porta — esperando 62s]"
  usa incoerente 37797; prepara sao-outro-endereco; local w; w="$(pid_do_arquivo)"
  sleep 62
  roda s
  rc_eh 2; contem "INCOERENTE"; nao_contem "vou encerrar"; nao_contem "VIVO-SEM-PORTA"; vivo "$w" "worker saudavel em outro endereco"
}

CENARIOS="${*:-c_saudavel c_morto c_reciclado c_surdo_sim c_surdo_nao c_so_olhar c_alheio c_nao_sondei c_start_falha c_subindo c_hook_falha c_host_config c_lentos c_incoerente}"
for c in $CENARIOS; do "$c"; done
for p in 37781 37782 37783 37784 37785 37786 37787 37788 37789 37790 37791 37792 37793 37794 37795 37796 37797; do
  for h in "$L"/home-*; do pkill -KILL -f "$h/" 2>/dev/null; done
  pkill -KILL -f "LABMARK-$p" 2>/dev/null
done
echo
echo "RESULTADO: $PASSOU ok · $FALHAS falha(s)"
[ "$FALHAS" = 0 ] && echo "LAB-VERDE" || echo "LAB-VERMELHO"
[ "$FALHAS" = 0 ]
