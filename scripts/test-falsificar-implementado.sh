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
ok()   { printf '  ✅ %s\n' "${1//$'\n'/ | }"; }
ruim() { printf '  ❌ %s\n' "${1//$'\n'/ | }"; falhas=$((falhas+1)); }

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
  roda() { FALSIF_DIR="$tmp" FALSIF_PKG="$tmp/pkg.json" bash "$0"; }

  # cenario <nome> — monta as fixtures do ZERO: um cenário nunca herda o arquivo do anterior.
  cenario() {
    rm -f "$tmp"/test-*.sh "$tmp/pkg.json"
    mk test-neutra.sh '#!/bin/sh
echo oi'
    mk test-boa.sh '#!/bin/sh
# Uso: --falsificar
if [ "${1:-}" = "--falsificar" ]; then echo sabota; fi'
    case "$1" in
      # sadias e registradas: o gate NÃO pode inventar defeito onde não há.
      sadio) pkg boa ;;
      # EIXO 1 — anuncia no cabeçalho e nunca lê $1 (o defeito de 2026-09-07).
      anuncia_sem_parsear) pkg boa
        mk test-ruim.sh '#!/bin/sh
# Uso: bash x --falsificar (sabota; exige vermelho)
echo suite' ;;
      # EIXO 2 — implementa certinho, mas fora da lista do CI: a flag existe e nunca roda. Estado
      #          equivalente ao defeito, e o mais difícil de notar.
      fora_do_ci) pkg outra-coisa ;;
      # package.json ilegível é AUSÊNCIA DE DADO, não aprovação silenciosa.
      lista_ilegivel) printf '{ "scripts": {} }\n' > "$tmp/pkg.json" ;;
      *) return 1 ;;
    esac
  }

  # (a) o cenário SADIO é a régua do laço: o gate sai 0 e não acusa eixo nenhum.
  cenario sadio
  roda > "$tmp/sadio.log" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && ! LC_ALL=C grep -q '❌' "$tmp/sadio.log"; then ok "fixtures sa(s) e registrada -> VERDE (nao inventa defeito)"
  else ruim "acusou fixture SÃ (exit $rc) — falso positivo torna o gate ignoravel"; fi

  # <cenário>:<eixo que TEM de acusá-lo> — o ID é o 1º token da linha ❌ do gate. Exit≠0 NÃO é
  # dente: até 2026-09-27 cada cenário contava QUALQUER vermelho — o do EIXO 1 passaria com o EIXO
  # 2 acusando no lugar, e um script quebrado (exit 2, 127) com qualquer um. O vermelho que conta é
  # o exit 1 do gate COM a acusação declarada, ausente no cenário sadio.
  # docs/historico/falsificacao-exit-nao-e-dente.md
  SABOTAGENS="anuncia_sem_parsear:EIXO1 fora_do_ci:EIXO2 lista_ilegivel:LISTA"
  # Nome repetido rodaria a mesma mutação duas vezes (e inflaria o recibo); `|` (OU) não é
  # suportado por este juiz: os dois greps poderiam casar MEMBROS diferentes (Codex, 2026-09-27).
  # shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
  repetidos="$(printf '%s\n' $SABOTAGENS | cut -d: -f1 | sort | uniq -d | tr '\n' ' ')"
  [ -z "$repetidos" ] || { ruim "SABOTAGENS com nome repetido: $repetidos"; }
  case "$SABOTAGENS" in *'|'*) ruim "SABOTAGENS com | (OU): declare por , (E) — este juiz exige o MESMO assert nos dois lados" ;; esac
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    if ! cenario "$sab"; then
      ruim "\"$sab\": na lista SABOTAGENS e SEM cenario — nada foi montado"; continue
    fi
    log="$tmp/$sab.log"
    roda > "$log" 2>&1; rc=$?
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if LC_ALL=C grep -Eq "^  ❌ ($exigido) " "$tmp/sadio.log" || ! LC_ALL=C grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    acusou="$({ LC_ALL=C grep -Eo '^  ❌ [A-Z0-9]+ ' "$log" || true; } | LC_ALL=C awk '{ printf "%s ", $2 }')"
    if [ "$rc" -eq 0 ]; then
      ruim "\"$sab\": fixture com o defeito passou VERDE"
    elif [ "$rc" -ne 1 ]; then
      ruim "\"$sab\": vermelho com exit $rc — o gate sai 1 quando acusa; outro exit e o script quebrando, nao o eixo"
    elif [ -n "$faltam" ]; then
      ruim "\"$sab\": vermelho, mas o eixo declarado NAO acusou:$faltam · acusou: ${acusou:-nada}"
    else
      ok "\"$sab\" -> vermelho no eixo declarado ($exigidos)"
    fi
  done

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: o gate reage aos 2 eixos NO eixo certo e poupa o sadio"; exit 0
  else echo "❌ falsificacao: $falhas problema(s) no proprio gate"; exit 1; fi
fi

echo "▶ --falsificar: anunciado x implementado x rodado pelo CI"

CI_LISTA=" $(lista_ci) "
if [ "$CI_LISTA" = "  " ]; then
  ruim "LISTA nao li a lista do test:falsificacao em $PKG — ausencia de dado, NAO aprovacao"
  echo; echo "❌ falsificar-implementado: 1 problema"; exit 1
fi

achou_alvo=0
for f in "$DIR"/test-*.sh; do
  [ -f "$f" ] || continue
  anuncia "$f" || continue
  achou_alvo=1
  b=$(basename "$f"); slug=${b#test-}; slug=${slug%.sh}
  if ! parseia "$f"; then
    ruim "EIXO1 $b anuncia --falsificar no cabecalho e NUNCA le \$1"
    printf '       a flag cai na suite normal e sai VERDE (exit 0) — o cabecalho\n'
    printf '       promete VERMELHO. Implemente o bloco ou tire a linha do "Uso:".\n'
    continue
  fi
  case "$CI_LISTA" in
    *" $slug "*) ok "$b (implementa e o CI roda)" ;;
    *) ruim "EIXO2 $b implementa --falsificar mas esta FORA do test:falsificacao"
       printf '       o CI nunca executa a flag: existe e nao roda = inerte igual.\n'
       printf '       Adicione `%s` a lista do test:falsificacao no package.json.\n' "$slug" ;;
  esac
done

[ "$achou_alvo" = 1 ] || echo "   (nenhum arquivo anuncia --falsificar em $DIR)"

echo
if [ "$falhas" -eq 0 ]; then echo "✅ falsificar-implementado: tudo verde"; exit 0
else echo "❌ falsificar-implementado: $falhas arquivo(s) prometendo o que nao cumpre"; exit 1; fi
