#!/usr/bin/env bash
# test-retry-pgdg.sh — ponto de entrada do laboratorio do RETRY do step "PostgreSQL 17 (PGDG)"
# do .github/workflows/ci.yml (scripts/lab-retry-pgdg/).
#
# O que esta suite protege: o `provas-sql` e check OBRIGATORIO e tem tres chamadas de rede. Sem
# retry, um soluco de rede trava um PR ate alguem re-rodar a mao — medido em 2026-09-21
# (run 35549862278, `curl: (56)`) e, antes da mitigacao das fontes de terceiro, em 2026-09-09.
# Com retry MAL FEITO e pior: `|| true` ou `for ... && break` transformam falha REAL do PGDG em
# verde silencioso, e a prova de SQL de risco passa a rodar contra um Postgres que ninguem
# conferiu. As duas metades sao provadas separadamente, porque falham por motivos opostos:
#   · lab.sh        — RETENTA no transitorio, DESISTE no permanente (9 cenarios, 29 assercoes);
#   · falsifica.sh  — o lab SABE ficar vermelho (5 sabotagens, controle verde antes da 1a).
#
# Sem rede: curl/apt-get/lsb_release/sudo/sleep sao dublês num PATH de mktemp, e o texto do step
# vem do proprio ci.yml a cada invocacao (copia envelheceria calada).
#
# Uso: bash scripts/test-retry-pgdg.sh                (exit 0 = tudo verde)
#      bash scripts/test-retry-pgdg.sh --falsificar   (sabota o retry; EXIGE vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
LAB="$here/lab-retry-pgdg"

# ── Sondas fail-CLOSED e POSITIVAS ───────────────────────────────────────────────────────────────
# `command -v python3` nao basta: python3 presente SEM PyYAML faria a extracao do step falhar la
# dentro, e a suite reprovaria com um traceback que parece defeito do retry. Pior seria o inverso —
# uma sonda que "pula" a suite quando falta ferramenta e verde por AUSENCIA DE DADO
# (docs/historico/sonda-ausente-em-script-que-apaga.md).
falta=""
sonda() { # sonda <nome> <comando...> — exige resposta POSITIVA, nao so presenca no PATH
  local nome="$1"; shift
  "$@" >/dev/null 2>&1 || falta="$falta $nome"
}
sonda python3 python3 -c 'import sys; sys.exit(0)'
sonda pyyaml python3 -c 'import yaml; yaml.safe_load("a: 1")'
if [ -n "$falta" ]; then
  echo "FALHA: ferramenta(s) ausente(s) ou quebrada(s):$falta — o laboratorio NAO rodou."
  echo "       Isto REPROVA de proposito: ausencia de dado nao e verde."
  exit 1
fi

roda() { # roda <script do lab> <marcador verde>
  local saida rc
  saida="$(mktemp)"
  bash "$LAB/$1" >"$saida" 2>&1
  rc=$?
  cat "$saida"
  # Exit 0 E o marcador: exit 0 sozinho nao distingue "rodou tudo e passou" de "morreu cedo por
  # um caminho que devolve 0"; o marcador sozinho nao distingue "terminou" de "terminou bem".
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
