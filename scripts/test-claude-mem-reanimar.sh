#!/usr/bin/env bash
# test-claude-mem-reanimar.sh — o laboratorio do scripts/claude-mem-reanimar.sh dentro do test:hooks.
#
# O claude-mem-reanimar.sh MATA processo (o worker do claude-mem vivo-mas-surdo, 05/09 e 24/09 —
# docs/historico/claude-mem-worker-vivo-mas-surdo.md). O lab (scripts/lab-claude-mem-reanimar/)
# instala um plugin FALSO num HOME descartavel e prova cada ramo — os que matam e os que se recusam
# a matar — sem tocar no claude-mem real. Roda no Linux (CI) e no macOS (onde o script e usado).
#
# Sonda fail-CLOSED e POSITIVA: sem uma ferramenta, o lab NAO roda, e isso REPROVA — nunca pula.
# "Ausente" num runner novo (o ubuntu-latest vira 26.04 em nov/2026) e exatamente o dia em que um
# verde por ausencia esconderia a regressao. `command -v` nao basta: presente-porem-quebrada
# esvazia a suite igual (docs/historico/sonda-ausente-em-script-que-apaga.md).
#
# Veredito so com EVIDENCIA POSITIVA: exit 0 E o marcador (LAB-VERDE / FALSIFICACAO-VERDE) na
# saida. Exit 0 sem o marcador = o lab parou no meio.
#
# Uso: bash scripts/test-claude-mem-reanimar.sh               (exit 0 = LAB-VERDE)
#      bash scripts/test-claude-mem-reanimar.sh --falsificar  (sabota cada guarda; EXIGE vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
LAB="$here/lab-claude-mem-reanimar"

falta=""
sonda() { # sonda <nome> <comando...> — exige resposta POSITIVA, nao so presenca no PATH
  local nome="$1"
  shift
  "$@" >/dev/null 2>&1 || falta="$falta $nome"
}
sonda python3 python3 -c 'import pty, select, socket'
sonda node node -e 'process.exit(0)'
sonda curl curl --version
sonda sqlite3 sqlite3 :memory: 'select 1'
sonda lsof sh -c 'lsof -v 2>&1 | grep -qi revision'
# pkill que nao casa nada sai 1 ("nenhum processo"); 2/3 = sintaxe/erro, 127 = ausente
sonda pkill sh -c 'pkill -f "nenhum-processo-casa-isto-$$"; [ $? -eq 1 ]'
if [ "$(uname -s)" = Linux ]; then
  # o subreaper recolhe os zumbis que o PID 1 de um container nao recolhe (ver README do lab)
  sonda prctl python3 -c 'import ctypes; ctypes.CDLL(None).prctl'
fi
if [ -n "$falta" ]; then
  echo "FALHA: ferramenta(s) ausente(s) ou quebrada(s):$falta — o laboratorio NAO rodou."
  echo "       Isto REPROVA de proposito: ausencia de dado nao e verde."
  exit 1
fi

roda() { # roda <script do lab> <marcador verde>
  local saida rc
  saida="$(mktemp)"
  if [ "$(uname -s)" = Linux ]; then
    python3 "$LAB/subreaper.py" bash "$LAB/$1" >"$saida" 2>&1
  else
    bash "$LAB/$1" >"$saida" 2>&1 # no macOS quem recolhe orfaos e o launchd
  fi
  rc=$?
  cat "$saida"
  if [ "$rc" -eq 0 ] && grep -qx "$2" "$saida"; then
    rm -f "$saida"
    return 0
  fi
  if grep -qx "$2" "$saida"; then
    echo "FALHA: $1 saiu $rc"
  else
    echo "FALHA: $1 saiu $rc e SEM o marcador $2"
  fi
  rm -f "$saida"
  return 1
}

if [ "${1:-}" = "--falsificar" ]; then
  roda falsifica.sh FALSIFICACAO-VERDE
  exit $?
fi
roda lab.sh LAB-VERDE
