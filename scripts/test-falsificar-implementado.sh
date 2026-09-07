#!/usr/bin/env bash
# test-falsificar-implementado.sh — gate de DOIS eixos sobre o `--falsificar`:
#   (1) quem ANUNCIA a flag no cabeçalho tem de PARSEAR `$1` de verdade;
#   (2) quem PARSEIA tem de estar na lista do `test:falsificacao` do
#       package.json — senão o CI nunca a executa e a flag é inerte igual.
#
# Por quê (2026-09-07): o `test-onde-parei.sh` falhava nos DOIS. Anunciava no
# "Uso:" a linha
#   bash scripts/test-onde-parei.sh --falsificar (sabota a correção; exige vermelho)
# sem UMA linha de código lendo `$1`, e estava fora do `test:falsificacao`. A
# flag caía na suíte normal e saía VERDE — exit 0, saída byte-a-byte idêntica à
# do controle. Quem seguisse o cabeçalho recebia verde de um contrato que
# promete VERMELHO e anotava "falsificação feita": veredito fabricado a partir
# de código que não existe, a mesma família de `ausente != zero`
# (CLAUDE.md §Armadilhas). O eixo (2) é o que explica o defeito ter durado —
# ninguém nunca rodou a flag, então nunca viu que ela não fazia nada.
#
# O eixo (2) é de propósito uma fonte POR FORA dos scripts (o package.json):
# gate que só se pergunta sobre o material que ele mesmo varre herda o ponto
# cego desse material.
#
# Detecta por COMPORTAMENTO, não por intenção: exige ≥1 linha NÃO-comentário
# que cite `--falsificar` E referencie `$1`. Critério medido contra os 5
# arquivos que já implementavam — todos passam.
#
# Uso: bash scripts/test-falsificar-implementado.sh              (exit 0 = verde)
#      bash scripts/test-falsificar-implementado.sh --falsificar (exige vermelho)
# shellcheck disable=SC2016  # aspas simples são de propósito no arquivo todo:
# `$1` aqui é o TEXTO que o grep procura DENTRO dos alvos, e as fixtures são
# código literal. Expandir escreveria um padrão que não casa — o gate ficaria
# verde por cegueira, o defeito exato que ele existe para pegar.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
DIR="${FALSIF_DIR:-$here}"
PKG="${FALSIF_PKG:-$here/../package.json}"

falhas=0
ok()   { printf '  ✅ %s\n' "$1"; }
ruim() { printf '  ❌ %s\n' "$1"; falhas=$((falhas+1)); }

anuncia() { grep -q -- '--falsificar' "$1"; }
parseia() {
  grep -- '--falsificar' "$1" | grep -v '^[[:space:]]*#' \
    | grep -qE '\$\{1:-\}|"\$1"|\$1'
}
# A lista que o CI de fato executa. Vazio aqui é AUSÊNCIA DE DADO (formato do
# package.json mudou, arquivo sumiu), nunca "ninguém está registrado" — tratado
# como erro explícito lá embaixo em vez de reprovar todo mundo pelo motivo errado.
lista_ci() {
  [ -f "$PKG" ] || return 0
  sed -n 's/.*"test:falsificacao": "for t in \([^;]*\);.*/\1/p' "$PKG"
}

if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (fixtures com o defeito EXIGEM vermelho) ==\n'
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

  # CONTROLE primeiro: sem um verde de partida, todo vermelho abaixo é ruído.
  # Roda a MESMA invocação do laço (recursão com os dois overrides) sobre o
  # material REAL — se já estiver sujo, abortamos antes de fabricar veredito.
  if FALSIF_DIR="$here" FALSIF_PKG="$PKG" bash "$0" >/dev/null 2>&1; then
    ok "controle: scripts/ + package.json reais -> VERDE"
  else
    ruim "controle ja VERMELHO — conserte antes; sabotar sobre vermelho nao prova nada"
    printf '\n❌ falsificacao ABORTADA: sem verde de partida.\n'; exit 1
  fi

  mk()  { printf '%s\n' "$2" > "$tmp/$1"; }
  # pkg <slugs...> — package.json de fixture com a lista do CI
  pkg() { printf '{ "scripts": { "test:falsificacao": "for t in %s; do bash x; done" } }\n' "$*" > "$tmp/pkg.json"; }
  roda() { FALSIF_DIR="$tmp" FALSIF_PKG="$tmp/pkg.json" bash "$0" >/dev/null 2>&1; }

  mk test-neutra.sh '#!/bin/sh
echo oi'
  mk test-boa.sh '#!/bin/sh
# Uso: --falsificar
if [ "${1:-}" = "--falsificar" ]; then echo sabota; fi'

  # (a) sadias e registradas: o gate NÃO pode inventar defeito onde não há.
  pkg boa
  if roda; then ok "fixtures sa(s) e registrada -> VERDE (nao inventa defeito)"
  else ruim "acusou fixture SÃ — falso positivo torna o gate ignoravel"; fi

  # (b) EIXO 1 — anuncia no cabeçalho e nunca lê $1 (o defeito de 2026-09-07).
  mk test-ruim.sh '#!/bin/sh
# Uso: bash x --falsificar (sabota; exige vermelho)
echo suite'
  if roda; then ruim "EIXO 1: fixture que anuncia sem parsear passou VERDE"
  else ok "EIXO 1: anuncia sem parsear -> vermelho"; fi
  rm -f "$tmp/test-ruim.sh"

  # (c) EIXO 2 — implementa certinho, mas fora da lista do CI: a flag existe e
  #     nunca roda. Estado equivalente ao defeito, e o mais difícil de notar.
  pkg outra-coisa
  if roda; then ruim "EIXO 2: fixture fora do test:falsificacao passou VERDE"
  else ok "EIXO 2: implementa mas o CI nao roda -> vermelho"; fi

  # (d) package.json ilegível é AUSÊNCIA DE DADO, não aprovação silenciosa.
  printf '{ "scripts": {} }\n' > "$tmp/pkg.json"
  if roda; then ruim "package.json sem a lista passou VERDE — ausencia virou aprovacao"
  else ok "lista do CI ilegivel -> vermelho (ausencia != aprovacao)"; fi

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: o gate reage aos 2 eixos e poupa o sadio"; exit 0
  else echo "❌ falsificacao: $falhas problema(s) no proprio gate"; exit 1; fi
fi

echo "▶ --falsificar: anunciado x implementado x rodado pelo CI"

CI_LISTA=" $(lista_ci) "
if [ "$CI_LISTA" = "  " ]; then
  ruim "nao li a lista do test:falsificacao em $PKG — ausencia de dado, NAO aprovacao"
  echo; echo "❌ falsificar-implementado: 1 problema"; exit 1
fi

achou_alvo=0
for f in "$DIR"/test-*.sh; do
  [ -f "$f" ] || continue
  anuncia "$f" || continue
  achou_alvo=1
  b=$(basename "$f"); slug=${b#test-}; slug=${slug%.sh}
  if ! parseia "$f"; then
    ruim "$b anuncia --falsificar no cabecalho e NUNCA le \$1"
    printf '       a flag cai na suite normal e sai VERDE (exit 0) — o cabecalho\n'
    printf '       promete VERMELHO. Implemente o bloco ou tire a linha do "Uso:".\n'
    continue
  fi
  case "$CI_LISTA" in
    *" $slug "*) ok "$b (implementa e o CI roda)" ;;
    *) ruim "$b implementa --falsificar mas esta FORA do test:falsificacao"
       printf '       o CI nunca executa a flag: existe e nao roda = inerte igual.\n'
       printf '       Adicione `%s` a lista do test:falsificacao no package.json.\n' "$slug" ;;
  esac
done

[ "$achou_alvo" = 1 ] || echo "   (nenhum arquivo anuncia --falsificar em $DIR)"

echo
if [ "$falhas" -eq 0 ]; then echo "✅ falsificar-implementado: tudo verde"; exit 0
else echo "❌ falsificar-implementado: $falhas arquivo(s) prometendo o que nao cumpre"; exit 1; fi
