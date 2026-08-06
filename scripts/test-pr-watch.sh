#!/usr/bin/env bash
# test-pr-watch.sh — TDD do scripts/pr-watch.sh com `gh` STUBADO (sem rede).
#
# Contrato testado (exit codes): 0=MERGED · 2=CLOSED · 3=DIRTY(conflito) ·
# 4=CI vermelho · 5=CONSULTEI e o PR segue sem desfecho · 6=NÃO CONSEGUI
# CONSULTAR (estado DESCONHECIDO — confirmar à mão antes de reportar).
#
# 5 vs 6 é o coração deste teste. Até o #1396 os dois saíam 5: o watcher não
# conseguiu consultar (2 falhas + relógio saltando o deadline com a máquina
# dormindo), saiu 5, e o PR tinha MERGEADO — falso negativo reportado ao
# founder. Se algum dia "não consegui consultar" voltar a sair 5, este teste
# fica vermelho.
#
# O último caso cobre o GATILHO do mesmo incidente: a janela conta VIGÍLIA, não
# relógio de parede. Ali o exit code não discrimina (5 nos dois mundos) — o
# observável é quantas vezes o script chegou a consultar.
#
# Uso: bash scripts/test-pr-watch.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
WATCH="$here/pr-watch.sh"

stub="$(mktemp -d)"
tempo="$(mktemp -d)"
trap 'rm -rf "$stub" "$tempo"' EXIT

# Stubs de TEMPO — usados SÓ pelo teste de salto de relógio (entram no PATH
# apenas naquele caso, pros demais seguirem exercitando date/sleep de verdade).
# Relógio VIRTUAL num arquivo: `sleep N` não dorme, só adianta o relógio em
# N + SLEEP_SALTO. Assim dá pra simular a máquina suspendendo — de forma
# determinística e instantânea, sem esperar 40min de verdade.
cat >"$tempo/date" <<'STUB'
#!/bin/sh
cat "$PR_WATCH_RELOGIO"
STUB
cat >"$tempo/sleep" <<'STUB'
#!/bin/sh
agora="$(cat "$PR_WATCH_RELOGIO")"
echo $(( agora + $1 + ${SLEEP_SALTO:-0} )) > "$PR_WATCH_RELOGIO"
STUB
chmod +x "$tempo/date" "$tempo/sleep"

# stub de gh:
#   GH_STUB_EXIT=N   → falha SEMPRE com N (rede fora o tempo todo)
#   GH_STUB_FALHAS=N → falha as N PRIMEIRAS chamadas e depois devolve o JSON
#                      (a rede volta — cenário real do #1396)
#   senão            → devolve o JSON do cenário (GH_STUB_FILE)
cat >"$stub/gh" <<'STUB'
#!/bin/sh
n=0
[ -f "$GH_STUB_CONTADOR" ] && n="$(cat "$GH_STUB_CONTADOR")"
n=$((n + 1)); printf '%s' "$n" > "$GH_STUB_CONTADOR"
[ -n "${GH_STUB_EXIT:-}" ] && exit "$GH_STUB_EXIT"
[ "$n" -le "${GH_STUB_FALHAS:-0}" ] && exit 1
cat "$GH_STUB_FILE"
STUB
chmod +x "$stub/gh"
export PATH="$stub:$PATH"
export GH_STUB_CONTADOR="$stub/contador"
# backoff da cartada final zerado: o teste prova a SEQUÊNCIA, não a espera
export PR_WATCH_BACKOFFS="0 0 0"

fail=0

# roda o watcher com timeout curtíssimo (0 min) e poll de 1s
# $4 = quantas consultas falham antes de a rede voltar (default 0)
# $5 = trecho que a saída PRECISA conter (default: não checa) — sem isso um
#      exit 5 "não consegui consultar" se disfarça de exit 5 "consultei"
caso() {
  local nome="$1" want_exit="$2" json="$3" falhas="${4:-0}" want_saida="${5:-}" out rc
  printf '%s' "$json" > "$stub/cenario.json"
  rm -f "$GH_STUB_CONTADOR"
  out="$(GH_STUB_FILE="$stub/cenario.json" GH_STUB_FALHAS="$falhas" bash "$WATCH" 999 0 1 2>/dev/null)"; rc=$?
  if [ "$rc" -ne "$want_exit" ]; then
    echo "  FAIL  want exit $want_exit, got $rc | $nome | $out"; fail=1; return
  fi
  if [ -n "$want_saida" ] && ! grep -q "$want_saida" <<<"$out"; then
    echo "  FAIL  exit $rc ok, mas a saída não diz \"$want_saida\" | $nome | $out"; fail=1; return
  fi
  echo "  ok    exit $rc | $nome"
}

echo "── desfechos terminais ──"
caso "MERGED → 0" 0 '{"state":"MERGED","mergeStateStatus":"CLEAN","statusCheckRollup":[],"title":"t","url":"u"}'
caso "CLOSED sem merge → 2" 2 '{"state":"CLOSED","mergeStateStatus":"","statusCheckRollup":[],"title":"t","url":"u"}'
caso "conflito (DIRTY) → 3" 3 '{"state":"OPEN","mergeStateStatus":"DIRTY","statusCheckRollup":[],"title":"t","url":"u"}'
caso "CI vermelho (conclusion FAILURE) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"FAILURE"}],"title":"t","url":"u"}'
caso "CI vermelho (state ERROR, sem conclusion) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"context":"ci","state":"error"}],"title":"t","url":"u"}'

echo "── consultei e o PR segue sem desfecho (→ 5) ──"
caso "OPEN limpo até o deadline → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":null}],"title":"t","url":"u"}'

# check pendente NÃO pode contar como vermelho (falso-positivo)
caso "check pendente ≠ vermelho → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","state":"PENDING"}],"title":"t","url":"u"}'

echo "── NÃO consegui consultar (→ 6, nunca 5) ──"
# Regressão do #1396: "não sei o estado" não pode se disfarçar de "sem desfecho".
rm -f "$GH_STUB_CONTADOR"
out="$(GH_STUB_EXIT=1 GH_STUB_FILE=/dev/null bash "$WATCH" 999 0 1 2>/dev/null)"; rc=$?
if [ "$rc" -eq 6 ]; then echo "  ok    exit 6 | gh falhando sempre (rede/rate-limit) → DESCONHECIDO"
else echo "  FAIL  want exit 6, got $rc | gh falhando sempre → DESCONHECIDO"; fail=1; fi

# gh vivo mas devolvendo lixo (JSON ilegível) também é "não sei", não "sem desfecho"
caso "JSON ilegível → 6" 6 'nao-e-json'

echo "── cartada final: a rede volta antes de desistir ──"
# O caso REAL do #1396: máquina dormiu, o relógio saltou o deadline e as
# primeiras consultas falharam — mas o PR já tinha MERGEADO. O desfecho real
# precisa vencer o timeout, senão o watcher mente sobre um PR que fechou.
caso "falha 2×, a rede volta e acha MERGED → 0" 0 '{"state":"MERGED","mergeStateStatus":"CLEAN","statusCheckRollup":[],"title":"t","url":"u"}' 2 MERGEADO
caso "falha 1×, a rede volta e o PR segue OPEN → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":null}],"title":"t","url":"u"}' 1 'ainda OPEN'

echo "── relógio saltando (máquina suspendendo) ──"
# A janela quer dizer "N min VIGIANDO", não N min de relógio de parede. Se o
# laptop dorme, `sleep` não avança mas o relógio salta — e o watcher queimava a
# janela inteira tendo consultado 2× (foi o GATILHO do #1396).
#
# O exit code NÃO discrimina aqui (com ou sem o fix dá 5): o observável é
# QUANTAS vezes ele realmente consultou. Janela de 5min com poll de 60s = ~6
# consultas; sem o fix, o 1º sono de 40min encerra tudo na 2ª.
echo 1000000000 > "$tempo/relogio"
rm -f "$GH_STUB_CONTADOR"
printf '%s' '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[],"title":"t","url":"u"}' > "$stub/cenario.json"
# Watchdog: com `sleep` stubado (instantâneo), errar a aritmética do salto —
# creditar o elapsed inteiro em vez do EXCESSO — faria o deadline recuar tanto
# quanto avança, e o teste TRAVARIA em vez de falhar. Aqui vira exit 143 = FAIL.
PATH="$tempo:$PATH" PR_WATCH_RELOGIO="$tempo/relogio" SLEEP_SALTO=2400 \
  GH_STUB_FILE="$stub/cenario.json" bash "$WATCH" 999 5 60 >"$tempo/saida" 2>/dev/null &
alvo=$!
( sleep 20 && kill "$alvo" 2>/dev/null ) >/dev/null 2>&1 &
cao=$!
wait "$alvo"; rc=$?
kill "$cao" 2>/dev/null
polls="$(cat "$GH_STUB_CONTADOR" 2>/dev/null || echo 0)"
if [ "$rc" -eq 5 ] && [ "$polls" -ge 5 ]; then
  echo "  ok    exit 5 após $polls polls | 40min de sono por poll não queimam a janela de 5min"
else
  echo "  FAIL  want exit 5 com ≥5 polls, got exit $rc com $polls poll(s) | a janela foi queimada pelo relógio, não pela vigília"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
