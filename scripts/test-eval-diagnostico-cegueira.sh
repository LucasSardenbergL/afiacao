#!/usr/bin/env bash
# test-eval-diagnostico-cegueira.sh — dente do diagnóstico de cegueira do
# `sonda-veredito-401-eval.sh` (bloco entre os marcadores `<<diagnostico-cegueira`).
#
# Por que existe: em 2026-09-07 o step de falsificação ficou VERMELHO num run e VERDE noutro no
# MESMO sha, e a única pista era "alvo sumiu do gerador" — que não distingue "o alvo sumiu" de
# "não consegui procurar", nem diz ONDE a divergência nasceu (captura × cópia × fonte). O
# diagnóstico nasceu para a PRÓXIMA ocorrência se autodiagnosticar; este teste é o que impede
# que ele apodreça em silêncio.
#
# `--falsificar`: sabota o bloco (uma regra por vez) e EXIGE vermelho em cada sabotagem. Opera
# sempre sobre CÓPIA em diretório temporário — nunca sobre o arquivo versionado.
set -uo pipefail

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
EVAL_SH="$RAIZ/.claude/skills/lovable-deploy-verify/evals/sonda-veredito-401-eval.sh"
FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

[ -f "$EVAL_SH" ] || { echo "❌ eval não encontrado: $EVAL_SH" >&2; exit 2; }

CAIXA=$(mktemp -d) || exit 2
limpar() { rm -rf "$CAIXA"; }
trap limpar EXIT

# Extrai o bloco entre os marcadores. Fail-closed: bloco vazio/sem as funções é ERRO de
# medição (exit 2), nunca "passou" — o marcador some num refactor e o teste viraria vácuo.
extrair_bloco() { # destino
  awk '/^# <<diagnostico-cegueira/{f=1} f{print} /^# diagnostico-cegueira>>/{if(f) exit}' \
    "$EVAL_SH" > "$1"
  local faltando=0 fn
  for fn in 'sha_de()' 'tem_alvo()' 'linha_eixo()' 'diagnostico_cegueira()'; do
    command grep -qF "$fn" "$1" || { echo "   bloco extraído SEM $fn" >&2; faltando=1; }
  done
  return "$faltando"
}

# Roda as asserções contra UM bloco. Ecoa "ok:<n>" / "falha:<n>"; retorna 1 se houve falha.
rodar_asserts() { # bloco.sh
  local bloco="$1" ok=0 falha=0 box
  box=$(mktemp -d -p "$CAIXA" 2>/dev/null || mktemp -d "$CAIXA/box.XXXXXX") || return 2

  # Ambiente que o bloco espera. `TMP`/`GER`/`RAIZ_REPO`/`ORIG` são os 4 eixos do diagnóstico.
  local TMP="$box/tmp" GER="$box/ger" RAIZ_REPO="$box/repo" ORIG
  mkdir -p "$TMP" "$GER" "$RAIZ_REPO/scripts"
  printf 'linha um\nALVO-PRESENTE aqui\nlinha tres\n' > "$GER/sonda-versao-sql.ts"
  cp "$GER/sonda-versao-sql.ts" "$RAIZ_REPO/scripts/sonda-versao-sql.ts"
  # shellcheck disable=SC2034  # ORIG é lido pelo BLOCO sourceado abaixo (diagnostico_cegueira),
  # não por este arquivo — o shellcheck não enxerga através do `.`
  ORIG=$(cat "$GER/sonda-versao-sql.ts")

  # shellcheck source=/dev/null
  . "$bloco" || return 2

  afirmar() { # rótulo esperado obtido
    if [ "$2" = "$3" ]; then ok=$((ok + 1))
    else falha=$((falha + 1)); echo "   ✗ $1: esperado [$2], veio [$3]" >&2
    fi
  }

  # 1-3: as TRÊS respostas de tem_alvo são distinguíveis. "não achei" ≠ "não consegui procurar":
  # colapsá-las é ausência de dado virando veredito — o defeito que o diagnóstico veio fechar.
  afirmar 'tem_alvo presente'  'SIM' "$(tem_alvo "$GER/sonda-versao-sql.ts" 'ALVO-PRESENTE')"
  afirmar 'tem_alvo ausente'   'NAO' "$(tem_alvo "$GER/sonda-versao-sql.ts" 'NAO-EXISTE-ISSO')"
  afirmar 'tem_alvo ilegível'  'ERRO-GREP-2' "$(tem_alvo "$box/nao-existe.ts" 'qualquer')"

  # 4: sha_de NUNCA volta vazio — vazio compararia igual a vazio e leria como "arquivos iguais".
  local s; s=$(sha_de "$GER/sonda-versao-sql.ts")
  if [ -n "$s" ]; then ok=$((ok + 1)); else falha=$((falha + 1)); echo "   ✗ sha_de vazio" >&2; fi

  # 5: o ramo SEM ferramenta de hash precisa ser ALCANÇADO para valer — com `shasum` no PATH ele
  # nunca roda, e a asserção acima é vácua nele. `PATH=` derruba os dois `command -v`; `printf` é
  # builtin e sobrevive. Vazio aqui compararia igual a vazio e leria como "arquivos iguais" —
  # falso-verde justamente no eixo que existe para acusar diferença.
  # shellcheck disable=SC1007  # `PATH=` VAZIO é o ponto do caso: é ele que derruba os dois
  # `command -v` e faz o ramo do fallback ser alcançado. Não é assignment esquecido.
  afirmar 'sha_de sem ferramenta' 'SEM-FERRAMENTA-DE-HASH' "$(PATH= sha_de "$GER/sonda-versao-sql.ts" 2>/dev/null)"

  # 5-7: o diagnóstico imprime os TRÊS eixos, nomeados. Um eixo mudo é o falso-verde perfeito:
  # sem ele não se sabe se a divergência nasceu na captura, na cópia ou na fonte.
  local saida; saida=$(diagnostico_cegueira 'ALVO-PRESENTE' 2>&1)
  local eixo
  for eixo in 'captura(ORIG)' 'copia(GER)' 'fonte(repo)'; do
    if printf '%s' "$saida" | command grep -qF "$eixo"; then ok=$((ok + 1))
    else falha=$((falha + 1)); echo "   ✗ diagnóstico sem o eixo $eixo" >&2; fi
  done

  # 8: cópia ≠ fonte tem de APARECER — é a hipótese nº 1 do incidente (a cópia mutada).
  printf 'linha um\nMUTADO\nlinha tres\n' > "$GER/sonda-versao-sql.ts"
  saida=$(diagnostico_cegueira 'ALVO-PRESENTE' 2>&1)
  if printf '%s' "$saida" | command grep -q 'divergencia'; then ok=$((ok + 1))
  else falha=$((falha + 1)); echo "   ✗ divergência cópia×fonte não foi reportada" >&2; fi

  # 9: e o eixo da CÓPIA tem de dizer NAO com o alvo fora dela (o diagnóstico mede o arquivo,
  # não repete o que a captura disse).
  if printf '%s' "$saida" | command grep -qE 'copia\(GER\).*alvo=NAO'; then ok=$((ok + 1))
  else falha=$((falha + 1)); echo "   ✗ eixo da cópia não acusou alvo=NAO" >&2; fi

  echo "ok:$ok falha:$falha"
  [ "$falha" -eq 0 ]
}

BLOCO="$CAIXA/bloco.sh"
extrair_bloco "$BLOCO" || { echo "❌ extração do bloco falhou (marcador sumiu?)" >&2; exit 2; }

# CONTROLE VERDE na MESMA invocação, ANTES da 1ª sabotagem. Sem ele, um bloco sempre-vermelho
# aprovaria TODAS as sabotagens de uma vez — cada uma "pegaria" um vermelho que já existia.
res=$(rodar_asserts "$BLOCO" 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
  echo "❌ CONTROLE VERMELHO com o bloco ÍNTEGRO — nenhuma sabotagem foi tentada:"
  printf '%s\n' "$res"
  exit 1
fi
echo "  ✅ controle: $(printf '%s' "$res" | command grep -oE 'ok:[0-9]+') com o bloco íntegro"

if [ "$FALSIFICAR" -eq 0 ]; then
  echo "── resultado: bloco de diagnóstico íntegro e com os 3 eixos ──"
  exit 0
fi

echo "== falsificação — sabota o diagnóstico e exige vermelho =="
cegas=0
sabotar() { # nome de para
  local nome="$1" de="$2" para="$3" mut="$CAIXA/mutante.sh"
  if ! command grep -qF "$de" "$BLOCO"; then
    echo "  [XX ] sabotagem NO-OP (alvo sumiu do bloco): $nome" >&2; cegas=$((cegas + 1)); return
  fi
  ORIG_BLOCO=$(cat "$BLOCO")
  printf '%s' "$ORIG_BLOCO" | python3 -c 'import sys; d,p=sys.argv[1],sys.argv[2]; sys.stdout.write(sys.stdin.read().replace(d,p))' "$de" "$para" > "$mut"
  if rodar_asserts "$mut" >/dev/null 2>&1; then
    echo "  [XX ] sabotagem PASSOU DESPERCEBIDA: $nome" >&2; cegas=$((cegas + 1))
  else
    echo "  [ok ] pegada: $nome"
  fi
}

sabotar "'não achei' e 'não consegui procurar' colapsam num só veredito" \
        "*) printf 'ERRO-GREP-%s' \"\$rc\" ;;" "*) printf 'NAO' ;;"
sabotar "o ramo NAO passa a mentir SIM (a asserção do ausente vira teatro)" \
        "1) printf 'NAO' ;;" "1) printf 'SIM' ;;"
sabotar "sha_de volta VAZIO quando não há ferramenta (vazio==vazio leria 'iguais')" \
        "printf 'SEM-FERRAMENTA-DE-HASH'" "printf ''"
sabotar "o eixo da CÓPIA some do diagnóstico" \
        "linha_eixo 'copia(GER)' \"\$copia\" \"\$de\"" ":"
sabotar "o eixo da CAPTURA some do diagnóstico" \
        "linha_eixo 'captura(ORIG)' \"\$cap\" \"\$de\"" ":"
sabotar "a divergência cópia×fonte deixa de ser reportada" \
        "printf '         1a divergencia" ": '         1a divergencia"

if [ "$cegas" -ne 0 ]; then
  echo "── falsificação: $cegas cegueira(s) (esperado: 0) ──" >&2
  exit 1
fi
echo "── falsificação: 6 sabotagens, 6 pegadas · 0 cegueira ──"
