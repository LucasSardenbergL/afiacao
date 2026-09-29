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

# Roda as asserções contra UM bloco. Cada assert imprime `✓ D<n>` ou `✗ D<n>` (o ID é o que a
# falsificação exige no log) e o recibo final "ok:<n> falha:<n>"; retorna 1 se houve falha.
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

  afirmar() { # ID rótulo esperado obtido
    if [ "$3" = "$4" ]; then ok=$((ok + 1)); echo "   ✓ $1 $2" >&2
    else falha=$((falha + 1)); echo "   ✗ $1 $2: esperado [${3//$'\n'/ | }], veio [${4//$'\n'/ | }]" >&2
    fi
  }

  # 1-3: as TRÊS respostas de tem_alvo são distinguíveis. "não achei" ≠ "não consegui procurar":
  # colapsá-las é ausência de dado virando veredito — o defeito que o diagnóstico veio fechar.
  afirmar D1 'tem_alvo presente'  'SIM' "$(tem_alvo "$GER/sonda-versao-sql.ts" 'ALVO-PRESENTE')"
  afirmar D2 'tem_alvo ausente'   'NAO' "$(tem_alvo "$GER/sonda-versao-sql.ts" 'NAO-EXISTE-ISSO')"
  afirmar D3 'tem_alvo ilegível'  'ERRO-GREP-2' "$(tem_alvo "$box/nao-existe.ts" 'qualquer')"

  # 4: sha_de NUNCA volta vazio — vazio compararia igual a vazio e leria como "arquivos iguais".
  local s; s=$(sha_de "$GER/sonda-versao-sql.ts")
  if [ -n "$s" ]; then ok=$((ok + 1)); echo "   ✓ D4 sha_de nao vazio" >&2
  else falha=$((falha + 1)); echo "   ✗ D4 sha_de vazio" >&2; fi

  # 5: o ramo SEM ferramenta de hash precisa ser ALCANÇADO para valer — com `shasum` no PATH ele
  # nunca roda, e a asserção acima é vácua nele. `PATH=` derruba os dois `command -v`; `printf` é
  # builtin e sobrevive. Vazio aqui compararia igual a vazio e leria como "arquivos iguais" —
  # falso-verde justamente no eixo que existe para acusar diferença.
  # shellcheck disable=SC1007  # `PATH=` VAZIO é o ponto do caso: é ele que derruba os dois
  # `command -v` e faz o ramo do fallback ser alcançado. Não é assignment esquecido.
  afirmar D5 'sha_de sem ferramenta' 'SEM-FERRAMENTA-DE-HASH' "$(PATH= sha_de "$GER/sonda-versao-sql.ts" 2>/dev/null)"

  # 5-7: o diagnóstico imprime os TRÊS eixos, nomeados. Um eixo mudo é o falso-verde perfeito:
  # sem ele não se sabe se a divergência nasceu na captura, na cópia ou na fonte.
  local saida; saida=$(diagnostico_cegueira 'ALVO-PRESENTE' 2>&1)
  local par id eixo
  for par in 'D6 captura(ORIG)' 'D7 copia(GER)' 'D8 fonte(repo)'; do
    id="${par%% *}"; eixo="${par#* }"
    if printf '%s' "$saida" | command grep -qF "$eixo"; then ok=$((ok + 1)); echo "   ✓ $id diagnóstico com o eixo $eixo" >&2
    else falha=$((falha + 1)); echo "   ✗ $id diagnóstico sem o eixo $eixo" >&2; fi
  done

  # 8: cópia ≠ fonte tem de APARECER — é a hipótese nº 1 do incidente (a cópia mutada).
  printf 'linha um\nMUTADO\nlinha tres\n' > "$GER/sonda-versao-sql.ts"
  saida=$(diagnostico_cegueira 'ALVO-PRESENTE' 2>&1)
  if printf '%s' "$saida" | command grep -q 'divergencia'; then ok=$((ok + 1)); echo "   ✓ D9 divergência cópia×fonte reportada" >&2
  else falha=$((falha + 1)); echo "   ✗ D9 divergência cópia×fonte não foi reportada" >&2; fi

  # 9: e o eixo da CÓPIA tem de dizer NAO com o alvo fora dela (o diagnóstico mede o arquivo,
  # não repete o que a captura disse).
  if printf '%s' "$saida" | command grep -qE 'copia\(GER\).*alvo=NAO'; then ok=$((ok + 1)); echo "   ✓ D10 eixo da cópia acusou alvo=NAO" >&2
  else falha=$((falha + 1)); echo "   ✗ D10 eixo da cópia não acusou alvo=NAO" >&2; fi

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

echo "== falsificação — sabota o diagnóstico e exige vermelho NO ASSERT que a sabotagem declara =="
# <sabotagem>:<IDs dos asserts que TÊM de acusá-la> — `,` = E, `|` = OU; o ID é o que o assert
# imprime (`✗ D3 …`). Exit≠0 NÃO é dente: até 2026-09-27 este laço contava "pegada" para QUALQUER
# retorno ≠0 de rodar_asserts — inclusive o 2 de um bloco que nem CARREGOU (sabotagem que quebra a
# sintaxe), e o `replace` trocava TODAS as ocorrências do alvo. Colaterais ficam de fora.
# docs/historico/falsificacao-exit-nao-e-dente.md
SABOTAGENS="colapsa_ilegivel:D3 ausente_mente_sim:D2 sha_vazio_sem_ferramenta:D5 sem_eixo_copia:D7
            sem_eixo_captura:D6 sem_divergencia:D9"

# registra <nome> <descrição> <de> <para> — a TABELA das sabotagens. Nome da lista sem registro e
# registro fora da lista são cegueira (abaixo): o primeiro não sabotaria nada, o segundo nunca roda.
registradas=""
registra() {
  case " $registradas " in *" $1 "*) echo "registra: nome REPETIDO ($1) — o 2o registro sobrescreveria o 1o" >&2; exit 2 ;; esac
  registradas="$registradas $1"
  printf -v "desc_$1" '%s' "$2"; printf -v "de_$1" '%s' "$3"; printf -v "para_$1" '%s' "$4"
}
registra colapsa_ilegivel "'não achei' e 'não consegui procurar' colapsam num só veredito" \
        "*) printf 'ERRO-GREP-%s' \"\$rc\" ;;" "*) printf 'NAO' ;;"
registra ausente_mente_sim "o ramo NAO passa a mentir SIM (a asserção do ausente vira teatro)" \
        "1) printf 'NAO' ;;" "1) printf 'SIM' ;;"
registra sha_vazio_sem_ferramenta "sha_de volta VAZIO quando não há ferramenta (vazio==vazio leria 'iguais')" \
        "printf 'SEM-FERRAMENTA-DE-HASH'" "printf ''"
registra sem_eixo_copia "o eixo da CÓPIA some do diagnóstico" \
        "linha_eixo 'copia(GER)' \"\$copia\" \"\$de\"" ":"
registra sem_eixo_captura "o eixo da CAPTURA some do diagnóstico" \
        "linha_eixo 'captura(ORIG)' \"\$cap\" \"\$de\"" ":"
registra sem_divergencia "a divergência cópia×fonte deixa de ser reportada" \
        "printf '         1a divergencia" ": '         1a divergencia"

# troca <bloco> <mutante> — DE→PARA exatamente UMA vez (0 = o alvo sumiu: NO-OP; >1 = a troca
# mexeria em mais de um lugar e a sabotagem deixaria de ser "uma regra por vez").
troca() {
  python3 - "$1" "$2" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
de, para = os.environ['DE'], os.environ['PARA']
s = open(src, encoding='utf-8').read()
n = s.count(de)
if n != 1:
    sys.stderr.write(f'o alvo casa {n}x no bloco (esperado: 1)\n'); sys.exit(3)
open(dst, 'w', encoding='utf-8').write(s.replace(de, para, 1))
PY
}
# asserts EXECUTADOS numa rodada = ok+falha do recibo final; vazio se ela abortou antes dele
executados() { LC_ALL=C sed -n 's/^ok:\([0-9][0-9]*\) falha:\([0-9][0-9]*\)$/\1 \2/p' "$1" | LC_ALL=C awk '{ print $1 + $2 }'; }
vermelhos() { { LC_ALL=C grep -Eo '^   ✗ D[0-9]+ ' "$1" || true; } | LC_ALL=C awk '{ printf "%s ", $2 }'; }
# A camada 4. O bloco é carregado com `.` — roda no MESMO processo que os asserts, e não há embrulho
# possível —, então o "stderr do alvo" é tudo o que a rodada imprimiu FORA das linhas de assert (✓/✗)
# e do recibo, julgado INTEIRO contra o do controle. O que o bloco imprime dentro de `$(… 2>&1)` é o
# que os asserts D6–D10 julgam, e fica com eles.
# shellcheck source=scripts/lib/falsificacao-stderr.sh disable=SC1091
. "$RAIZ/scripts/lib/falsificacao-stderr.sh"
fora_dos_asserts() { { LC_ALL=C grep -vE '^   (✓|✗) |^ok:[0-9]+ falha:[0-9]+$' "$1" || true; } > "$1.stderr"; }

ctl="$CAIXA/controle.log"; printf '%s\n' "$res" > "$ctl"; fora_dos_asserts "$ctl"
echo "  ✅ linha de base do controle: $(linha_de_base "$ctl")"
cegas=0
mut="$CAIXA/mutante.sh"
# A rodada só conta como PEGADA com as quatro camadas: (1) a troca aplicou 1× e o mutante tem
# sintaxe válida; (2) rodar_asserts rodou INTEIRA (ok+falha = o do controle); (3) cada assert
# declarado está ✓ no controle e ✗ aqui; (4) nenhuma linha que o controle não tem fora dos asserts
# (`camada4`: tudo o que o bloco imprimiu, por linha normalizada) — não só as assinaturas do bash.
# Nome repetido rodaria a mesma mutação duas vezes (e inflaria o recibo); `|` (OU) não é
# suportado por este juiz: os dois greps poderiam casar MEMBROS diferentes (Codex, 2026-09-27).
# shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
repetidos="$(printf '%s\n' $SABOTAGENS | cut -d: -f1 | sort | uniq -d | tr '\n' ' ')"
[ -z "$repetidos" ] || { echo "  [XX ] SABOTAGENS com nome repetido: $repetidos" >&2; cegas=$((cegas + 1)); }
case "$SABOTAGENS" in *'|'*) echo "  [XX ] SABOTAGENS com | (OU): declare por , (E)" >&2; cegas=$((cegas + 1)) ;; esac
for item in $SABOTAGENS; do
  sab="${item%%:*}"; exigidos="${item#*:}"
  v="desc_$sab"; nome="${!v-}"; v="de_$sab"; de="${!v-}"; v="para_$sab"; para="${!v-}"
  if [ -z "$de" ]; then
    echo "  [XX ] \"$sab\" está na lista SABOTAGENS e SEM registro — nada foi sabotado" >&2; cegas=$((cegas + 1)); continue
  fi
  if ! DE="$de" PARA="$para" troca "$BLOCO" "$mut"; then
    echo "  [XX ] sabotagem NO-OP ou ambígua (o alvo não casa 1× no bloco): $nome" >&2; cegas=$((cegas + 1)); continue
  fi
  if ! bash -n "$mut" 2>/dev/null; then
    echo "  [XX ] a sabotagem quebrou a SINTAXE do bloco — vermelho pelo motivo errado: $nome" >&2; cegas=$((cegas + 1)); continue
  fi
  log="$CAIXA/sabotada-$sab.log"
  # SUBSHELL: rodar_asserts carrega o bloco com `.` — um `exit` sabotado sairia do TESTE, não dela.
  ( rodar_asserts "$mut" ) > "$log" 2>&1; rc_sab=$?; fora_dos_asserts "$log"
  if [ "$rc_sab" -eq 0 ]; then
    echo "  [XX ] sabotagem PASSOU DESPERCEBIDA: $nome" >&2; cegas=$((cegas + 1)); continue
  fi
  # Daqui em diante rodar_asserts saiu ≠0 — o que, sozinho, não prova NADA.
  faltam=""
  for exigido in ${exigidos//,/ }; do
    if ! LC_ALL=C grep -Eq "^   ✓ ($exigido) " "$ctl" || ! LC_ALL=C grep -Eq "^   ✗ ($exigido) " "$log"; then
      faltam="$faltam $exigido"
    fi
  done
  if [ "$(executados "$log")" != "$(executados "$ctl")" ]; then
    echo "  [XX ] vermelha SEM rodar os asserts inteiros ($(executados "$log") de $(executados "$ctl"); exit $rc_sab) — vermelho de aborto, não de assert: $nome" >&2
    cegas=$((cegas + 1))
  elif novas="$(camada4 "$sab" "$log" "$ctl" "$mut" "$BLOCO")"; [ -n "$novas" ]; then
    echo "  [XX ] vermelha com erro que o CONTROLE não tem — o assert caiu por crash, não por julgamento: $nome" >&2
    printf '%s\n' "$novas" | head -3 | LC_ALL=C sed 's/^/       /' >&2
    cegas=$((cegas + 1))
  elif [ -n "$faltam" ]; then
    echo "  [XX ] vermelha, mas o assert declarado NÃO virou (✓ no controle → ✗ aqui):$faltam · vermelhos: $(vermelhos "$log")— $nome" >&2
    cegas=$((cegas + 1))
  else
    echo "  [ok ] pegada no assert declarado ($exigidos) · vermelhos: $(vermelhos "$log")— $nome"
  fi
done
for r in $registradas; do
  case " $SABOTAGENS " in
    *[[:space:]]"$r:"*) ;;
    *) echo "  [XX ] \"$r\" registrada e FORA da lista SABOTAGENS — nunca roda" >&2; cegas=$((cegas + 1)) ;;
  esac
done

if [ "$cegas" -ne 0 ]; then
  echo "── falsificação: $cegas cegueira(s) (esperado: 0) ──" >&2
  exit 1
fi
echo "── falsificação: $(wc -w <<<"$SABOTAGENS" | tr -d ' ') sabotagens, todas pegadas no assert declarado · 0 cegueira ──"
