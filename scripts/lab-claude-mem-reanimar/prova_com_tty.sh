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
# Uso: bash prova_com_tty.sh               (exit 0 = PROVA-COM-TTY-VERDE)
#      bash prova_com_tty.sh --falsificar  (sabota cada guarda do helper numa COPIA; exige vermelho
#                                           pela FALHA esperada — FALSIFICACAO-COM-TTY-VERDE)
# Env: COM_TTY  o helper provado (default: o com_tty.py deste diretorio; a falsificacao aponta as copias)
set -u
L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PY="${PY:-python3}"
COM_TTY="${COM_TTY:-$L/com_tty.py}"

# ------------------------------------------------------------------------------ falsificacao
# Mesmas travas do falsifica.sh: CONTROLE (a mesma invocacao, copia intacta) VERDE antes do 1o sed,
# senao aborta — uma prova sempre-vermelha "detectaria" tudo; sed invalido / que nao mudou nada /
# que quebrou a sintaxe = PROBLEMA; vermelho so vale com a FALHA esperada e o marcador de fim.
# Locales: C sempre; pt_BR.UTF-8 quando existe (no runner Ubuntu nao existe, e a saida DIZ isso).
if [ "${1:-}" = "--falsificar" ]; then
  T="$(mktemp -d "${TMPDIR:-/tmp}/fals-com-tty.XXXXXX")" || { echo "FALSIFICACAO-COM-TTY-VERMELHA: mktemp falhou"; exit 1; }
  trap 'case "$T" in */fals-com-tty.?*) rm -rf "$T" ;; esac' EXIT
  LOCALES="C"
  if locale -a 2>/dev/null | grep -qiE '^pt_BR\.utf-?8$'; then
    LOCALES="C pt_BR.UTF-8"
  else
    echo "(pt_BR.UTF-8 nao existe neste sistema: so o locale C roda aqui — o 2o locale NAO foi provado nesta maquina)"
  fi
  N=0
  sabota() { NOME[N]="$1"; EXPR[N]="$2"; ESPERADO[N]="$3"; N=$((N + 1)); } # nome · sed · FALHA esperada
  sabota entrada-tardia-derruba-o-helper 's/if e.errno != errno.EIO:/if True:/' \
    'entrada tardia: rc esperado 2 (o do comando), veio 125'
  sabota erro-interno-com-rc-do-comando 's/^    sys.exit(125)$/    raise/' \
    'erro interno: rc esperado 125 (o do HELPER), veio 1'
  sabota entrada-nunca-entregue 's/if ler_entrada and entrada in prontos:/if False:/' \
    'a escrita tardia NAO aconteceu'

  cp "$COM_TTY" "$T/controle.py"
  echo "== controle (copia intacta, a mesma invocacao das sabotagens)"
  for loc in $LOCALES; do
    LC_ALL="$loc" COM_TTY="$T/controle.py" bash "$L/prova_com_tty.sh" >"$T/controle-$loc.txt" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ] && grep -qx 'PROVA-COM-TTY-VERDE' "$T/controle-$loc.txt"; then
      echo "  ok    [$loc] controle VERDE"
    else
      echo "  FALHA [$loc] controle SEM sabotagem ja esta VERMELHO (rc=$rc) — sem linha de base, sabotar nao prova nada:"
      grep -F '  FALHA ' "$T/controle-$loc.txt" | head -5
      echo "FALSIFICACAO-COM-TTY-VERMELHA"
      exit 1
    fi
  done

  echo "== sabotagens (cada uma exige vermelho, com a FALHA esperada, em: $LOCALES)"
  BOAS=0; PROBLEMAS=0; i=0
  while [ "$i" -lt "$N" ]; do
    copia="$T/sabotado-${NOME[i]}.py"
    erro="$(sed "${EXPR[i]}" "$COM_TTY" 2>&1 >"$copia")"
    problema=""
    if [ -n "$erro" ]; then
      problema=" sed invalido (${erro:0:60}) — falsificacao vazia"
    elif cmp -s "$COM_TTY" "$copia"; then
      problema=" o sed nao mudou nada — falsificacao vazia (o helper mudou de forma?)"
    elif ! "$PY" -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$copia" 2>/dev/null; then
      problema=" o sed quebrou a SINTAXE do python — vermelho pelo motivo errado"
    else
      for loc in $LOCALES; do
        r="$T/res-$i-$loc.txt"
        LC_ALL="$loc" COM_TTY="$copia" bash "$L/prova_com_tty.sh" >"$r" 2>&1
        rc=$?
        if [ "$rc" -eq 0 ]; then
          problema="$problema [$loc] ficou VERDE (a prova nao cobre esta guarda)"
        elif ! grep -qx 'PROVA-COM-TTY-VERMELHA' "$r"; then
          problema="$problema [$loc] saiu sem o marcador PROVA-COM-TTY-VERMELHA (a prova nao terminou)"
        elif ! grep -F '  FALHA ' "$r" | grep -qF -- "${ESPERADO[i]}"; then
          problema="$problema [$loc] vermelho pelo MOTIVO ERRADO: $(grep -m1 -F '  FALHA ' "$r" | sed 's/^ *//' | cut -c1-90)"
        fi
      done
    fi
    if [ -z "$problema" ]; then
      echo "  ok    [${NOME[i]}] vermelho pelo motivo certo ($(printf '%s' "${ESPERADO[i]}" | cut -c1-60))"
      BOAS=$((BOAS + 1))
    else
      echo "  PROBLEMA [${NOME[i]}]$problema"
      PROBLEMAS=$((PROBLEMAS + 1))
    fi
    i=$((i + 1))
  done
  echo
  echo "FALSIFICACAO-COM-TTY: $BOAS guardas provadas · $PROBLEMAS problema(s) · locales: $LOCALES"
  if [ "$PROBLEMAS" = 0 ] && [ "$BOAS" = "$N" ]; then echo "FALSIFICACAO-COM-TTY-VERDE"; else echo "FALSIFICACAO-COM-TTY-VERMELHA"; fi
  [ "$PROBLEMAS" = 0 ] && [ "$BOAS" = "$N" ]
  exit $?
fi

# ------------------------------------------------------------------------------ prova

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
