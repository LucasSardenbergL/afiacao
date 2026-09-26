#!/usr/bin/env bash
# lab.sh — exercita o RETRY do step "PostgreSQL 17 (PGDG)" do .github/workflows/ci.yml.
#
# O que roda aqui e o TEXTO REAL do step, extraido do ci.yml a cada invocacao — nao uma copia da
# logica. Copia envelhece calada: alguem mexe no ci.yml, o lab continua verde sobre a versao antiga
# e a prova vira retrato. O unico desvio e mecanico e declarado: os tres prefixos absolutos
# (/usr/lib/postgresql, /usr/share/postgresql-common, /etc/apt) passam a apontar para uma raiz em
# $TMPDIR, porque o lab nao e root. Cada substituicao e conferida POSITIVAMENTE (guarda 1): se uma
# delas casar zero vezes, o lab estaria medindo o sistema de verdade — ou nada — e aborta.
#
# Rede: ZERO. curl/apt-get/lsb_release/sleep sao dublês no PATH. O dublê de `sudo` faz `exec "$@"`,
# entao `sudo curl` resolve para o dublê de curl.
#
# Os cenarios existem para separar as duas metades do retry, que falham por motivos OPOSTOS:
#   · RETENTA  (C1-C4): falha transitoria tem de virar VERDE, com a re-tentativa no log. Um retry
#     que nao retenta e' o step de hoje com mais linhas.
#   · DESISTE  (C5-C8): alvo permanentemente quebrado tem de REPROVAR, com o exit da ULTIMA
#     tentativa (56 do curl, 100 do apt) e o rotulo da camada. Verde aqui e' o `|| true` que o
#     comentario do step proibe — o modo de falha que o autor anterior recusou de proposito.
# E cada camada e sabotada SOZINHA: se a permanente de uma delas sair verde, aquela camada esta
# inalcancada ou redundante, e o lab reprova dizendo isso.
#
# Uso: bash scripts/lab-retry-pgdg/lab.sh      (exit 0 = tudo verde; imprime LAB-VERDE/LAB-VERMELHO)
# Env: ALVO_YML (default .github/workflows/ci.yml) — o falsifica.sh aponta para a copia sabotada.
set -u

L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RAIZ_REPO="$(cd "$L/../.." && pwd -P)"
YML="${ALVO_YML:-$RAIZ_REPO/.github/workflows/ci.yml}"
PASSO="PostgreSQL 17 (PGDG)"

tmpbase="${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${tmpbase%/}/lab-pgdg.XXXXXX")" || { echo "LAB-VERMELHO: mktemp falhou"; exit 1; }
trap 'case "$TMP" in */lab-pgdg.?*) rm -rf "$TMP" ;; esac' EXIT

ok=0; ruim=0

# ── Extracao do step ─────────────────────────────────────────────────────────────────────────────
# Por parser de YAML, nao por sed: o bloco e' um escalar literal com indentacao significativa e
# continuacoes de linha; recortar por regex erraria em silencio na primeira mudanca de layout.
if ! python3 - "$YML" "$PASSO" "$TMP/passo-cru.sh" <<'PY'
import sys, yaml
yml, nome, saida = sys.argv[1], sys.argv[2], sys.argv[3]
d = yaml.safe_load(open(yml, encoding="utf-8"))
cand = [s for s in d["jobs"]["provas-sql"]["steps"] if s.get("name", "").startswith(nome)]
if len(cand) != 1:
    sys.exit(f"esperava 1 step comecando com {nome!r}, achei {len(cand)}")
open(saida, "w", encoding="utf-8").write(cand[0]["run"])
PY
then
  echo "LAB-VERMELHO: nao consegui extrair o step '$PASSO' de $YML"
  exit 1
fi

# ── Guarda 1: a substituicao de prefixos tem de CASAR ────────────────────────────────────────────
SANDBOX="$TMP/raiz"
mkdir -p "$SANDBOX/etc/apt/sources.list.d" "$SANDBOX/usr/lib" "$SANDBOX/usr/share"
if ! python3 - "$TMP/passo-cru.sh" "$TMP/passo.sh" "$SANDBOX" <<'PY'
import sys
cru, saida, raiz = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(cru, encoding="utf-8").read()
faltou = []
for pref in ("/usr/lib/postgresql", "/usr/share/postgresql-common", "/etc/apt"):
    n = t.count(pref)
    if n == 0:
        faltou.append(pref)
    t = t.replace(pref, raiz + pref)
if faltou:
    sys.exit("prefixos que nao existem mais no step (lab mediria o sistema real): " + ", ".join(faltou))
open(saida, "w", encoding="utf-8").write(t)
PY
then
  # `if !` e nao `$?`: com o heredoc no meio, o `$?` lido depois e' um convite ao SC2181 — a mesma
  # classe que o shellcheck-gate existe para pegar nos harness de prova deste repo.
  echo "LAB-VERMELHO: guarda de sandbox reprovou — o lab nao esta medindo o que diz medir"
  exit 1
fi

# ── Dublês ───────────────────────────────────────────────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
CONT="$TMP/contadores"; mkdir -p "$CONT"

cat > "$BIN/sudo" <<'EOS'
#!/usr/bin/env bash
exec "$@"
EOS

cat > "$BIN/lsb_release" <<'EOS'
#!/usr/bin/env bash
echo noble
EOS

# `sleep` dublado: o retry real espera 5s e depois 10s. O lab nao encurta o codigo de producao
# para caber no relogio — encurta o RELOGIO.
cat > "$BIN/sleep" <<'EOS'
#!/usr/bin/env bash
echo "  (lab: sleep $* engolido)" >&2
exit 0
EOS

# Dublê generico de camada: conta a invocacao e decide pelo par LAB_<CAMADA>_{FALHAS,EXIT}.
# FALHAS=sempre  -> quebrado permanentemente.  FALHAS=<n> -> falha as n primeiras, depois passa.
cat > "$BIN/_camada" <<'EOS'
#!/usr/bin/env bash
set -u
camada="$1"; shift
cont="$LAB_CONT/$camada"
n=0; [ -f "$cont" ] && n="$(cat "$cont")"
n=$(( n + 1 )); printf '%s' "$n" > "$cont"
var_falhas="LAB_${camada}_FALHAS"; var_exit="LAB_${camada}_EXIT"
falhas="${!var_falhas:-0}"; codigo="${!var_exit:-1}"
if [ "$falhas" = "sempre" ] || { [ "$falhas" != "0" ] && [ "$n" -le "$falhas" ]; }; then
  echo "$LAB_MSG_ERRO" >&2
  exit "$codigo"
fi
exit 0
EOS

cat > "$BIN/curl" <<'EOS'
#!/usr/bin/env bash
# O -o do step precisa existir quando o curl "da certo": e o arquivo que o apt leria.
LAB_MSG_ERRO="curl: (56) Failure when receiving data from the peer" \
  "$LAB_BIN/_camada" CURL "$@" || exit $?
destino=""; anterior=""
for a in "$@"; do [ "$anterior" = "-o" ] && destino="$a"; anterior="$a"; done
[ -n "$destino" ] && printf 'CHAVE-PGDG-FALSA\n' > "$destino"
exit 0
EOS

cat > "$BIN/apt-get" <<'EOS'
#!/usr/bin/env bash
sub="update"
for a in "$@"; do case "$a" in update|install) sub="$a"; break ;; esac; done
if [ "$sub" = "install" ]; then
  LAB_MSG_ERRO="E: Unable to fetch some archives." \
    "$LAB_BIN/_camada" APTINS "$@" || exit $?
  # Instalar POSTGRESQL-17 e' o que faz o initdb passar a existir — e' assim que o step sai do
  # `if`. Sem isto, "install verde" nao se distinguiria de "install que nao fez nada".
  mkdir -p "$LAB_SANDBOX/usr/lib/postgresql/17/bin"
  printf '#!/usr/bin/env bash\necho "initdb (PostgreSQL) 17.11"\n' \
    > "$LAB_SANDBOX/usr/lib/postgresql/17/bin/initdb"
  chmod +x "$LAB_SANDBOX/usr/lib/postgresql/17/bin/initdb"
  exit 0
fi
LAB_MSG_ERRO="E: Hash Sum mismatch" "$LAB_BIN/_camada" APTUPD "$@" || exit $?
exit 0
EOS

chmod +x "$BIN"/*

# ── Executor de cenario ──────────────────────────────────────────────────────────────────────────
SAIDA=""; RC=0
roda() {
  rm -rf "$SANDBOX" "$CONT"
  mkdir -p "$SANDBOX/etc/apt/sources.list.d" "$CONT"
  SAIDA="$(
    env -i \
      PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
      HOME="$TMP" TMPDIR="$TMP" \
      LAB_BIN="$BIN" LAB_CONT="$CONT" LAB_SANDBOX="$SANDBOX" \
      "$@" \
      bash "$TMP/passo.sh" 2>&1
  )"; RC=$?
}

conta() { local c="$CONT/$1"; if [ -f "$c" ]; then cat "$c"; else echo 0; fi; }

falhou() { echo "   ❌ $1"; echo "$SAIDA" | sed 's/^/      | /' | head -40; ruim=$(( ruim + 1 )); }
passou() { echo "   ✅ $1"; ok=$(( ok + 1 )); }

# `verde <nome>`: exige exit 0 E o marcador POSITIVO do step (a versao conferida). Exit 0 sozinho
# nao distingue "instalou e conferiu" de "saiu cedo sem fazer nada".
verde() {
  local nome="$1"
  if [ "$RC" -ne 0 ]; then falhou "$nome — esperava VERDE, saiu $RC"; return 1; fi
  case "$SAIDA" in
    *"(PostgreSQL) 17.11"*) ;;
    *) falhou "$nome — saiu 0 mas sem a versao conferida no log"; return 1 ;;
  esac
  passou "$nome"
}

# `vermelho <nome> <exit-esperado> <marca>`: exit != 0 NAO basta — tem de ser o exit da ULTIMA
# tentativa (nao um 1 generico) e trazer a marca daquela camada. Vermelho pelo motivo errado
# (dublê quebrado, sandbox torta, bash com erro de sintaxe) tambem sai != 0.
vermelho() {
  local nome="$1" esperado="$2" marca="$3"
  if [ "$RC" -eq 0 ]; then falhou "$nome — esperava VERMELHO, saiu 0"; return 1; fi
  if [ "$RC" -ne "$esperado" ]; then
    falhou "$nome — exit $RC, esperava $esperado (o exit da ultima tentativa, nao um 1 generico)"; return 1
  fi
  case "$SAIDA" in
    *"$marca"*) ;;
    *) falhou "$nome — vermelho sem a marca '$marca'"; return 1 ;;
  esac
  passou "$nome"
}

espera_conta() {
  local camada="$1" esperado="$2" nome="$3" real
  real="$(conta "$camada")"
  if [ "$real" != "$esperado" ]; then
    falhou "$nome — $camada foi chamada ${real}x, esperava ${esperado}x"; return 1
  fi
  passou "$nome"
}

echo "── lab retry PGDG · alvo: ${YML#"$RAIZ_REPO"/} ──"

# C0 — CONTROLE. Sem sabotagem: verde, uma chamada por camada, e NENHUMA re-tentativa no log.
# Sem esta linha de base, os cenarios seguintes nao provam nada: um lab sempre-vermelho
# "detectaria" toda sabotagem, e um sempre-verde aprovaria todas.
roda
verde "C0 controle — sem falha, step verde"
espera_conta CURL 1   "C0 controle — curl chamado 1x"
espera_conta APTUPD 1 "C0 controle — apt-get update chamado 1x"
espera_conta APTINS 1 "C0 controle — apt-get install chamado 1x"
case "$SAIDA" in
  *"↻"*) falhou "C0 controle — logou re-tentativa sem nenhuma falha" ;;
  *) passou "C0 controle — zero re-tentativas no log" ;;
esac

# C1-C3 — RETENTA, uma camada por vez.
roda LAB_CURL_FALHAS=1 LAB_CURL_EXIT=56
verde "C1 curl transitorio (1 falha) — step verde"
espera_conta CURL 2 "C1 curl transitorio — curl chamado 2x"
case "$SAIDA" in
  *"↻ curl da chave do PGDG: OK na tentativa 2/3"*) passou "C1 curl transitorio — re-tentativa registrada no log" ;;
  *) falhou "C1 curl transitorio — verde, mas sem a linha de re-tentativa" ;;
esac

roda LAB_APTUPD_FALHAS=1 LAB_APTUPD_EXIT=100
verde "C2 apt-get update transitorio — step verde"
espera_conta APTUPD 2 "C2 apt-get update transitorio — chamado 2x"
case "$SAIDA" in
  *"↻ apt-get update: OK na tentativa 2/3"*) passou "C2 apt-get update transitorio — re-tentativa registrada" ;;
  *) falhou "C2 apt-get update transitorio — verde, mas sem a linha de re-tentativa" ;;
esac

roda LAB_APTINS_FALHAS=1 LAB_APTINS_EXIT=100
verde "C3 apt-get install transitorio — step verde"
espera_conta APTINS 2 "C3 apt-get install transitorio — chamado 2x"
case "$SAIDA" in
  *"↻ apt-get install postgresql-17: OK na tentativa 2/3"*) passou "C3 apt-get install transitorio — re-tentativa registrada" ;;
  *) falhou "C3 apt-get install transitorio — verde, mas sem a linha de re-tentativa" ;;
esac

# C4 — o teto e 3, nao 2: duas falhas seguidas ainda tem de virar verde na terceira.
roda LAB_CURL_FALHAS=2 LAB_CURL_EXIT=56
verde "C4 curl falha 2x — verde na terceira"
espera_conta CURL 3 "C4 curl falha 2x — curl chamado 3x"
case "$SAIDA" in
  *"OK na tentativa 3/3"*) passou "C4 curl falha 2x — terceira tentativa registrada" ;;
  *) falhou "C4 curl falha 2x — verde sem registrar a terceira" ;;
esac

# C5-C7 — DESISTE, uma camada por vez. Camada cuja permanente sai VERDE esta inalcancada.
roda LAB_CURL_FALHAS=sempre LAB_CURL_EXIT=56
vermelho "C5 curl PERMANENTE — reprova com o exit do curl" 56 "curl da chave do PGDG falhou nas 3 tentativas"
espera_conta CURL 3 "C5 curl PERMANENTE — tentou 3x (e parou)"
espera_conta APTUPD 0 "C5 curl PERMANENTE — nao seguiu para o apt-get (fail-closed de verdade)"
case "$SAIDA" in
  *"Failure when receiving data from the peer"*) passou "C5 curl PERMANENTE — erro real do curl visivel no log" ;;
  *) falhou "C5 curl PERMANENTE — reprovou sem mostrar o erro da ferramenta" ;;
esac
# O formato da mensagem de desistencia fica fixado AQUI, uma vez e com o acento que ela tem de
# verdade ("última"). O primeiro corte deste lab procurou "ultima" pelado e deu vermelho por isso:
# e a armadilha de caixa/acento do CLAUDE.md, e ela pertence a uma assercao so — repetida em cada
# cenario, viraria oito lugares para quebrar quando alguem reescrever a frase.
case "$SAIDA" in
  *"::error::curl da chave do PGDG falhou nas 3 tentativas — exit da última: 56"*)
    passou "C5 curl PERMANENTE — mensagem no formato exato (rotulo + teto + exit real)" ;;
  *) falhou "C5 curl PERMANENTE — a linha ::error:: mudou de formato" ;;
esac

roda LAB_APTUPD_FALHAS=sempre LAB_APTUPD_EXIT=100
vermelho "C6 apt-get update PERMANENTE — reprova com o exit do apt" 100 "apt-get update falhou nas 3 tentativas"
espera_conta APTUPD 3 "C6 apt-get update PERMANENTE — tentou 3x"
espera_conta APTINS 0 "C6 apt-get update PERMANENTE — nao seguiu para o install"

roda LAB_APTINS_FALHAS=sempre LAB_APTINS_EXIT=100
vermelho "C7 apt-get install PERMANENTE — reprova com o exit do apt" 100 "apt-get install postgresql-17 falhou nas 3 tentativas"
espera_conta APTINS 3 "C7 apt-get install PERMANENTE — tentou 3x"

# C8 — exatamente 3 falhas: nao existe quarta tentativa. Separa "o teto e 3" de "o teto e alto".
roda LAB_CURL_FALHAS=3 LAB_CURL_EXIT=56
vermelho "C8 curl falha exatamente 3x — reprova (nao ha 4a tentativa)" 56 "falhou nas 3 tentativas"
espera_conta CURL 3 "C8 curl falha 3x — curl chamado 3x"

echo ""
echo "── resultado: $ok ok · $ruim falha(s) ──"
if [ "$ruim" -eq 0 ]; then echo "LAB-VERDE"; exit 0; fi
echo "LAB-VERMELHO"; exit 1
