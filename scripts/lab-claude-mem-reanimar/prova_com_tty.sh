#!/usr/bin/env bash
# prova_com_tty.sh — o contrato do com_tty.py, o helper que da TTY ao script no lab: o rc que ele
# devolve e o DO COMANDO, ou um codigo PROPRIO fora da faixa do script (124 = teto, 125 = erro dele
# mesmo). Nunca um numero fabricado por ele que se confunda com um veredito do script.
#
# Por que existe — o flake de 2026-09-26 (M2 em swap, carga 51): o c_tempo_invalido disse o PAREI
# certo e voltou rc=1 em vez de 2. O 1 era do helper: sob carga ele repassou a resposta ao TTY DEPOIS
# que o comando ja tinha saido, o macOS devolveu EIO, e a excecao nao tratada o matou com 1 — o mesmo
# numero que o script usa para "nao consegui". Detalhe: docs/historico/claude-mem-worker-vivo-mas-surdo.md
#
# Deterministico: o entrada_tardia.py impoe a ordem que a carga produziu por acaso, e diz o que o
# kernel fez com a escrita tardia (recusou = o caminho real; aceitou = EIO emulado, dito na saida).
#
# Uso: bash prova_com_tty.sh    (exit 0 = PROVA-COM-TTY-VERDE)
# Env: COM_TTY  o helper provado (default: o com_tty.py deste diretorio)
set -u
L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PY="${PY:-python3}"
COM_TTY="${COM_TTY:-$L/com_tty.py}"

d="$(mktemp -d "${TMPDIR:-/tmp}/prova-com-tty.XXXXXX")" || { echo "PROVA-COM-TTY-VERMELHA: mktemp falhou"; exit 1; }
trap 'case "$d" in */prova-com-tty.?*) rm -rf "$d" ;; esac' EXIT
FALHAS=0
nok() { FALHAS=$((FALHAS + 1)); echo "  FALHA $1"; }
mostra() { echo "  --- fim da saida ($1) ---"; tail -12 "$d/$1" | sed 's/^/  | /'; }

# 1) entrada tardia: o comando escreve e sai 2 SEM ler o TTY; a resposta so chega depois dele SAIR
printf 's\n' | "$PY" "$L/entrada_tardia.py" "$COM_TTY" "$d/escreveu" 30 \
  bash -c 'echo "PAREI sem ler o TTY"; : >"$1"; exit 2' _ "$d/escreveu" >"$d/tardia.txt" 2>&1
rc=$?
kernel="$(grep -o 'o kernel [A-Z]* a entrada tardia' "$d/tardia.txt" | head -1)"
if [ -z "$kernel" ]; then # sem a escrita tardia, nada abaixo foi medido: ausencia de dado, nao verde
  nok "entrada tardia: a escrita tardia NAO aconteceu (rc=$rc) — o cenario nao rodou"; mostra tardia.txt
else
  n0="$FALHAS"
  [ "$rc" = 2 ] || nok "entrada tardia: rc esperado 2 (o do comando), veio $rc"
  grep -qF 'PAREI sem ler o TTY' "$d/tardia.txt" || nok "entrada tardia: a saida do comando nao passou pelo helper"
  grep -qF 'COM_TTY: entrada descartada' "$d/tardia.txt" || nok "entrada tardia: o helper nao disse que descartou a entrada"
  if [ "$FALHAS" = "$n0" ]; then echo "  ok    entrada tardia: rc=2, o do comando ($kernel)"; else mostra tardia.txt; fi
fi

# 2) erro do proprio helper (aqui, teto que nao e numero): codigo DELE, fora da faixa do script
"$PY" "$COM_TTY" nao-e-numero true >"$d/interno.txt" 2>&1
rc=$?
n0="$FALHAS"
[ "$rc" = 125 ] || nok "erro interno: rc esperado 125 (o do HELPER), veio $rc"
grep -qF 'COM_TTY: erro interno' "$d/interno.txt" || nok "erro interno: o helper nao disse que o erro e dele"
if [ "$FALHAS" = "$n0" ]; then echo "  ok    erro interno: rc=125, o do helper"; else mostra interno.txt; fi

if [ "$FALHAS" = 0 ]; then echo "PROVA-COM-TTY-VERDE"; else echo "PROVA-COM-TTY-VERMELHA"; fi
[ "$FALHAS" = 0 ]
