#!/usr/bin/env bash
# falsifica.sh — o lab do retry do PGDG tem de ficar VERMELHO quando o retry e' sabotado, e
# vermelho NO CENARIO CERTO. Sem isto o lab e' decoracao: 29 assercoes verdes nao provam que
# alguma delas olha para alguma coisa.
#
# Travas (vermelho pelo motivo errado conta como verde mentiroso):
#  (0) CONTROLE antes do 1o sed, na MESMA invocacao: a copia NAO sabotada tem de sair LAB-VERDE.
#      Lab sempre-vermelho "detecta" toda sabotagem; abortar aqui e' o unico jeito de saber.
#  (1) a substituicao tem de casar EXATAMENTE uma vez (padrao que envelheceu casa zero e a
#      sabotagem vira no-op — o lab segue verde e isso seria lido como "a guarda nao existe");
#  (2) o YAML tem de continuar valido e o bash do step tem de passar no `bash -n` (sintaxe
#      quebrada derruba o lab por motivo alheio a guarda que se quer provar);
#  (3) o vermelho tem de trazer os CASOS esperados marcados com ❌, e o C0 tem de continuar ✅ —
#      se o controle interno do lab cai junto, a sabotagem quebrou o lab, nao a guarda.
# Locales: C sempre; pt_BR.UTF-8 quando EXISTE (licao #1483 — falsificar num ambiente so nao prova
#   a assercao). Onde ele nao existe, a saida DIZ isso em vez de rodar C duas vezes e chamar de prova.
#
# Uso: bash scripts/lab-retry-pgdg/falsifica.sh
set -u

L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RAIZ_REPO="$(cd "$L/../.." && pwd -P)"
ORIG="${ALVO:-$RAIZ_REPO/.github/workflows/ci.yml}"
# O `tentar` mora em scripts/lib/tentar.sh desde o E19 (os steps do shellcheck pinado usam o mesmo
# helper). S1, S2 e S5 sabotam ESTE arquivo; S3 e S4, os pontos de uso no ci.yml.
ORIG_TENTAR="${ALVO_TENTAR:-$RAIZ_REPO/scripts/lib/tentar.sh}"

tmpbase="${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${tmpbase%/}/fals-pgdg.XXXXXX")" || { echo "FALSIFICACAO-VERMELHA: mktemp falhou"; exit 1; }
trap 'case "$TMP" in */fals-pgdg.?*) rm -rf "$TMP" ;; esac' EXIT

LOCALES="C"
if locale -a 2>/dev/null | grep -qiE '^pt_BR\.utf-?8$'; then
  LOCALES="C pt_BR.UTF-8"
else
  echo "(pt_BR.UTF-8 nao existe nesta maquina: so o locale C roda aqui — o 2o locale NAO foi provado)"
fi

ok=0; ruim=0
falhou() { echo "   ❌ $1"; ruim=$(( ruim + 1 )); }
passou() { echo "   ✅ $1"; ok=$(( ok + 1 )); }

# ── (2) o alvo sabotado ainda tem de ser YAML valido e bash valido ───────────────────────────────
confere_forma() { # confere_forma <yml|tentar> <arquivo>
  if [ "$1" = tentar ]; then bash -n "$2"; return; fi
  shift
  python3 - "$1" "$TMP/forma.sh" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
c = [s for s in d["jobs"]["provas-sql"]["steps"] if s.get("name", "").startswith("PostgreSQL 17")]
if len(c) != 1:
    sys.exit("step sumiu do YAML sabotado")
open(sys.argv[2], "w", encoding="utf-8").write(c[0]["run"])
PY
  bash -n "$TMP/forma.sh"
}

# ── a sabotagem, com a trava (1) embutida ────────────────────────────────────────────────────────
sabota() { # sabota <origem> <saida> <de> <para>
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import sys
orig, saida, de, para = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
t = open(orig, encoding="utf-8").read()
n = t.count(de)
if n != 1:
    sys.exit(f"padrao casou {n}x, esperava 1 — sabotagem seria no-op (ou dupla)")
open(saida, "w", encoding="utf-8").write(t.replace(de, para))
PY
}

# O 3o argumento recorta os cenarios. Cada sabotagem so pode ser vista pelos cenarios que a
# `prova` ja declara como `esperados` — rodar os outros oito em cada uma e' pagar ~2,5x por
# informacao conhecida. O C0 entra sempre (o lab o forca), que e' o que separa "a guarda caiu" de
# "o lab caiu". O LIMITE do recorte, dito de frente: uma sabotagem que tambem quebrasse um cenario
# fora da lista passaria despercebida AQUI — quem cobre isso e' o lab completo, que roda inteiro no
# controle desta mesma invocacao e no `test:hooks`.
# roda_lab <yml> <tentar> <locale> [cenarios]
roda_lab() { ALVO_YML="$1" ALVO_TENTAR="$2" LC_ALL="$3" LAB_CENARIOS="${4:-C1 C2 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14 C15 C16 C17 C18}" bash "$L/lab.sh" 2>&1; }

# ── (0) CONTROLE — antes de qualquer sabotagem, na mesma invocacao ───────────────────────────────
cp "$ORIG" "$TMP/controle.yml"
cp "$ORIG_TENTAR" "$TMP/controle-tentar.sh"
for loc in $LOCALES; do
  SAI="$(roda_lab "$TMP/controle.yml" "$TMP/controle-tentar.sh" "$loc")"
  case "$SAI" in
    *LAB-VERDE*) passou "controle [$loc] — lab verde sobre o ci.yml e o tentar.sh intactos" ;;
    *) echo "   ❌ controle [$loc] — lab NAO esta verde antes de sabotar; sabotar nao provaria nada"
       echo "$SAI" | sed 's/^/      | /' | head -30
       echo "FALSIFICACAO-VERMELHA: sem linha de base"; exit 1 ;;
  esac
done

# ── as sabotagens ────────────────────────────────────────────────────────────────────────────────
# Cada uma remove UMA propriedade do retry. `esperados` sao os casos do lab que TEM de ficar ❌;
# se um deles continuar verde, aquela assercao nao mede a propriedade que diz medir.
prova() { # prova <yml|tentar> <nome> <de> <para> <esperados> — sabota UM alvo; o outro segue o controle
  local alvo="$1" nome="$2" de="$3" para="$4" esperados="$5" loc yml tnt sab
  yml="$TMP/controle.yml"; tnt="$TMP/controle-tentar.sh"
  if [ "$alvo" = tentar ]; then
    sab="$TMP/sab-tentar.sh"; tnt="$sab"
    sabota "$ORIG_TENTAR" "$sab" "$de" "$para" 2>"$TMP/erro.txt" || {
      falhou "$nome — sabotagem invalida: $(head -c 200 "$TMP/erro.txt")"; return; }
  else
    sab="$TMP/sab.yml"; yml="$sab"
    sabota "$ORIG" "$sab" "$de" "$para" 2>"$TMP/erro.txt" || {
      falhou "$nome — sabotagem invalida: $(head -c 200 "$TMP/erro.txt")"; return; }
  fi
  if ! confere_forma "$alvo" "$sab" >"$TMP/forma.log" 2>&1; then
    falhou "$nome — alvo sabotado nao e YAML/bash valido: $(head -c 200 "$TMP/forma.log")"; return
  fi
  for loc in $LOCALES; do
    local SAI; SAI="$(roda_lab "$yml" "$tnt" "$loc" "$esperados")"
    case "$SAI" in
      *LAB-VERMELHO*) ;;
      *) falhou "$nome [$loc] — o lab NAO reprovou (a guarda nao existe)"; continue ;;
    esac
    case "$SAI" in
      *"✅ C0 controle — sem falha, step verde"*) ;;
      *) falhou "$nome [$loc] — derrubou o C0 junto: quebrou o lab, nao a guarda"; continue ;;
    esac
    local faltando="" c
    for c in $esperados; do
      case "$SAI" in
        *"❌ $c"*) ;;
        *) faltando="$faltando $c" ;;
      esac
    done
    if [ -n "$faltando" ]; then
      falhou "$nome [$loc] — vermelho, mas os casos${faltando} seguiram verdes"
    else
      passou "$nome [$loc] — vermelho nos casos certos ($esperados)"
    fi
  done
}

echo "── falsificacao do retry PGDG ──"

# shellcheck disable=SC2016  # aspas simples de proposito daqui para baixo: os `$` dentro dos
# padroes sao o TEXTO procurado DENTRO do ci.yml, nao variaveis deste script. Expandir escreveria um
# padrao que nao casa — a trava (1) pegaria, mas so depois de custar uma rodada.
# S1 — desistir passa a ser VERDE. E o `|| true` que o comentario do step proibe, escrito por dentro.
prova tentar "S1 'return \$rc' vira 'return 0' (desiste em silencio)" \
  '      return "$rc"' '      return 0' \
  "C5 C6 C7 C8"

# S2 — o teto cai para 1: o laco existe, mas nunca retenta.
prova tentar "S2 TENTATIVAS=3 vira 1 (nao retenta)" \
  'TENTATIVAS=3' 'TENTATIVAS=1' \
  "C1 C2 C3 C4"

# S3 — a chamada deixa de ser NUA. O `set -e` para de matar o step e a falha some.
prova yml "S3 '|| true' na chamada do curl (mascara a falha)" \
  'https://www.postgresql.org/media/keys/ACCC4CF8.asc
            echo "deb' 'https://www.postgresql.org/media/keys/ACCC4CF8.asc || true
            echo "deb' \
  "C5 C8"

# S4 — uma camada perde o retry. E' o teste de ALCANCE: se C3 seguisse verde sem o `tentar`,
# a assercao dele nao estaria olhando para o install.
prova yml "S4 apt-get install do fallback volta a ser chamado sem 'tentar' (camada sem retry)" \
  '              tentar "apt-get install postgresql-17 + pgvector" instalar' \
  '              instalar' \
  "C3 C7"

# S5 — some o `|| rc=$?`, o unico ponto onde o `set -e` fica suspenso de proposito. Sem ele o
# `set -e` mata a funcao na 1a falha e nao existe 2a tentativa: prova que aquela linha e' carga,
# nao enfeite.
prova tentar "S5 '\"\$@\" || rc=\$?' vira '\"\$@\"; rc=\$?' (set -e mata na 1a falha)" \
  '    "$@" || rc=$?' '    "$@"; rc=$?' \
  "C1 C2 C3 C4 C5"

# S6-S10 — as propriedades do E20 (plano v9), uma por vez.
# S6 — o fallback deixa de atualizar as fontes base: install que precisa de indice do Ubuntu fica
# sem saida, e C3/C10 (que contam a chamada base) tem de ver.
prova yml "S6 fallback sem o update das fontes base" \
  '              sudo timeout 240 apt-get update -qq
' '              true
' \
  "C3 C10"

# S7-S9 ancoram no update do PGDG PRINCIPAL (`timeout 60`, `pgdg.list`, chave `}` a 12 colunas): desde
# o pin (#3877) o update do apt-archive repete as mesmas opcoes, e o padrao solto casaria 2x.
prova yml "S7 update do PGDG sem --error-on=any (W: volta a sair 0)" \
  'timeout 60 apt-get update -qq --error-on=any' 'timeout 60 apt-get update -qq' \
  "C9"

prova yml "S8 update do PGDG volta a ler sources.list.d inteiro" \
  'pgdg.list \
                -o Dir::Etc::sourceparts=- -o' 'pgdg.list \
                -o' \
  "C9"

prova yml "S9 update do PGDG sem List-Cleanup=0 (apaga os outros indices)" \
  ' -o APT::Get::List-Cleanup=0 -o Acquire::Retries=0
            }' ' -o Acquire::Retries=0
            }' \
  "C9"

prova yml "S10 update do fallback sem timeout (orcamento furado)" \
  '              sudo timeout 240 apt-get update -qq
' '              sudo apt-get update -qq
' \
  "C9"

# S11-S14 — o PIN (#3877), uma camada por vez.
# shellcheck disable=SC2016  # `$` = texto procurado no ci.yml (ver S1)
prova yml "S11 conferencia do pin aceita qualquer minor" \
  '*"(PostgreSQL) $PG17_MINOR "*) ;;' '*) ;;' \
  "C16 C17"

prova yml "S12 sem o fallback do apt-archive (pin que saiu do indice vira vermelho)" \
  'tentar "apt-get update (apt-archive do PGDG)" atualizar_arquivo' 'true' \
  "C11 C15"

# shellcheck disable=SC2016  # `$` = texto procurado no ci.yml (ver S1)
prova yml "S13 schedule deixa de ignorar o pin (a minor nova nunca e' acusada)" \
  'PIN_DOS_PRS="${PG17_MINOR:-?}"; PG17_MINOR=""' 'PIN_DOS_PRS="${PG17_MINOR:-?}"' \
  "C13"

# shellcheck disable=SC2016  # `$` = texto procurado no ci.yml (ver S1)
prova yml "S14 pin vazio fora do schedule passa calado (instala a mais nova)" \
  ': "${PG17_MINOR:?pin ausente: defina PG17_MINOR no env: do job provas-sql}"' ': "${PG17_MINOR:=}"' \
  "C14"

# shellcheck disable=SC2016  # `$` = texto procurado no ci.yml (ver S1)
prova yml "S15 sem o espaco final na conferencia (17.1 casa 17.12)" \
  '*"(PostgreSQL) $PG17_MINOR "*)' '*"(PostgreSQL) $PG17_MINOR"*)' \
  "C17"

# shellcheck disable=SC2016  # `$` = texto procurado no ci.yml (ver S1)
prova yml "S16 conferencia do pgvector aceita qualquer versao" \
  '"$quer"-*) echo' '*) echo' \
  "C18"

echo ""
echo "── resultado: $ok ok · $ruim falha(s) ──"
if [ "$ruim" -eq 0 ]; then echo "FALSIFICACAO-VERDE"; exit 0; fi
echo "FALSIFICACAO-VERMELHA"; exit 1
