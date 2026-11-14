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
# Rede: ZERO. curl/apt-get/lsb_release/sleep/timeout sao dublês no PATH. O dublê de `sudo` faz
# `exec "$@"`, entao `sudo curl` resolve para o dublê de curl.
#
# Desde o E20 (plano v9) o step tem TRES chamadas de apt-get, e o dublê as separa pelos argumentos:
#   APTPGDG (update com `Dir::Etc::sourcelist=…/pgdg.list`), APTBASE (update das fontes base — so no
#   fallback), APTARQ (update do apt-archive do PGDG — so quando o PIN saiu do indice principal) e
#   APTINS (install). O `apt-cache madison` (consulta LOCAL, sem rede) tambem e' dublê: responde com
#   os indices de LAB_IDX_* e, depois de um APTARQ verde, tambem com os de LAB_ARQ_*. O que o lab NAO prova, dito de frente: resolucao de dependencia nem
#   que o apt de verdade preserva as outras listas. Isso so o runner prova (a instalacao real das 16
#   partes de `provas-sql`); aqui se prova o FLUXO — qual chamada acontece, quantas vezes, com que
#   opcoes, sob `timeout`, e o veredito de cada falha.
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
# Env: ALVO_YML (default .github/workflows/ci.yml) e ALVO_TENTAR (default scripts/lib/tentar.sh) — o
#      falsifica.sh aponta um ou outro para a copia sabotada.
#
# O `tentar` mora em scripts/lib/tentar.sh (os steps do shellcheck pinado usam o mesmo helper) e o
# step o carrega com `. scripts/lib/tentar.sh`. O lab EMBUTE o arquivo no lugar dessa linha (guarda
# 1b): rodar o `.` relativo dependeria do cwd de quem chama, e um `tentar` ausente faria o step
# morrer por "command not found" — vermelho pelo motivo errado, que o falsificador leria como dente.
set -u

L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RAIZ_REPO="$(cd "$L/../.." && pwd -P)"
YML="${ALVO_YML:-$RAIZ_REPO/.github/workflows/ci.yml}"
TENTAR="${ALVO_TENTAR:-$RAIZ_REPO/scripts/lib/tentar.sh}"
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
if ! python3 - "$TMP/passo-cru.sh" "$TMP/passo.sh" "$SANDBOX" "$TENTAR" <<'PY'
import sys
cru, saida, raiz, tentar = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
t = open(cru, encoding="utf-8").read()
# Guarda 1b: a linha que carrega o helper tem de existir UMA vez, e o helper entra no lugar dela.
fonte = ". scripts/lib/tentar.sh\n"
n = t.count(fonte)
if n != 1:
    sys.exit(f"o step carrega o tentar {n}x (esperava 1) — o lab nao saberia o que provar")
t = t.replace(fonte, open(tentar, encoding="utf-8").read())
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

# `timeout` dublado: marca o teto no ambiente e executa o resto. O apt-get dublê registra o teto
# que recebeu — "toda chamada de rede tem teto" vira assercao (C9), nao promessa do comentario.
cat > "$BIN/timeout" <<'EOS'
#!/usr/bin/env bash
LAB_SOB_TIMEOUT="$1"; export LAB_SOB_TIMEOUT; shift
exec "$@"
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
camada=APTBASE
case "$sub $*" in
  install*) camada=APTINS ;;
  *"Dir::Etc::sourcelist="*pgdg-archive.list*) camada=APTARQ ;;
  *"Dir::Etc::sourcelist="*pgdg.list*) camada=APTPGDG ;;
esac
printf '%s timeout=%s %s\n' "$camada" "${LAB_SOB_TIMEOUT:-nenhum}" "$*" >> "$LAB_CONT/args"
if [ "$sub" = "install" ]; then
  LAB_MSG_ERRO="E: Unable to fetch some archives." \
    "$LAB_BIN/_camada" APTINS "$@" || exit $?
  # Instalar POSTGRESQL-17 e' o que faz o initdb passar a existir — e' assim que o step sai do
  # `if`. Sem isto, "install verde" nao se distinguiria de "install que nao fez nada".
  # A minor do initdb sai do que foi PEDIDO (`postgresql-17=<versao>`); sem `=`, a mais nova do
  # indice. LAB_INITDB_FORCA simula o apt instalando outra coisa — e' o que a conferencia do pin pega.
  minor="${LAB_MAIS_NOVA:-17.13}"
  for a in "$@"; do case "$a" in postgresql-17=*) v="${a#postgresql-17=}"; minor="${v%%-*}" ;; esac; done
  minor="${LAB_INITDB_FORCA:-$minor}"
  mkdir -p "$LAB_SANDBOX/usr/lib/postgresql/17/bin"
  printf '#!/usr/bin/env bash\necho "initdb (PostgreSQL) %s (Ubuntu %s-1.pgdg24.04+1)"\n' "$minor" "$minor" \
    > "$LAB_SANDBOX/usr/lib/postgresql/17/bin/initdb"
  chmod +x "$LAB_SANDBOX/usr/lib/postgresql/17/bin/initdb"
  exit 0
fi
if [ "$camada" = APTARQ ]; then
  LAB_MSG_ERRO="E: Failed to fetch https://apt-archive.postgresql.org/pub/repos/apt/dists/noble-pgdg-archive/InRelease" \
    "$LAB_BIN/_camada" APTARQ "$@" || exit $?
  : > "$LAB_CONT/arquivo-no-indice"
  exit 0
fi
if [ "$camada" = APTPGDG ]; then
  LAB_MSG_ERRO="E: Failed to fetch https://apt.postgresql.org/pub/repos/apt/dists/noble-pgdg/InRelease" \
    "$LAB_BIN/_camada" APTPGDG "$@" || exit $?
  exit 0
fi
LAB_MSG_ERRO="E: base: Temporary failure resolving 'azure.archive.ubuntu.com'" \
  "$LAB_BIN/_camada" APTBASE "$@" || exit $?
exit 0
EOS

# `apt-cache madison <pkg>`: do mais novo ao mais velho, como o real. Indice principal = LAB_IDX_*;
# o apt-archive (LAB_ARQ_*) so entra depois que o update dele deu certo.
cat > "$BIN/apt-cache" <<'EOS'
#!/usr/bin/env bash
[ "$1" = madison ] || { echo "lab: apt-cache $1 nao dublado" >&2; exit 2; }
case "$2" in
  postgresql-17|postgresql-client-17) idx="$LAB_IDX_PG"; arq="$LAB_ARQ_PG" ;;
  postgresql-17-pgvector) idx="$LAB_IDX_VEC"; arq="$LAB_ARQ_VEC" ;;
  *) exit 0 ;;
esac
[ -f "$LAB_CONT/arquivo-no-indice" ] || arq=""
for v in $idx $arq; do
  printf ' %s | %s | https://apt.postgresql.org/pub/repos/apt noble-pgdg/main amd64 Packages\n' "$2" "$v"
done
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
      PG17_MINOR=17.12 PGVECTOR_VERSAO=0.8.7 \
      LAB_IDX_PG="17.13-1.pgdg24.04+1 17.12-1.pgdg24.04+1 17.11-1.pgdg24.04+2" \
      LAB_IDX_VEC="0.8.8-1.pgdg24.04+1 0.8.7-1.pgdg24.04+2 0.8.7-1.pgdg24.04+1" \
      LAB_ARQ_PG="17.11-1.pgdg24.04+2 17.10-1.pgdg24.04+1 17.1-1.pgdg24.04+1" \
      LAB_ARQ_VEC="0.8.6-1.pgdg24.04+1" \
      "$@" \
      bash "$TMP/passo.sh" 2>&1
  )"; RC=$?
}

conta() { local c="$CONT/$1"; if [ -f "$c" ]; then cat "$c"; else echo 0; fi; }

falhou() { echo "   ❌ $1"; echo "$SAIDA" | sed 's/^/      | /' | head -40; ruim=$(( ruim + 1 )); }
passou() { echo "   ✅ $1"; ok=$(( ok + 1 )); }

# `verde <nome> [marca]`: exige exit 0 E o marcador POSITIVO do step (a minor pinada conferida;
# default a 17.12 do `roda`). Exit 0 sozinho nao distingue "instalou e conferiu" de "saiu cedo".
verde() {
  local nome="$1" marca="${2:-PG17_PIN_OK minor=17.12}"
  if [ "$RC" -ne 0 ]; then falhou "$nome — esperava VERDE, saiu $RC"; return 1; fi
  case "$SAIDA" in
    *"$marca"*) ;;
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

# ── Seletor de cenarios ──────────────────────────────────────────────────────────────────────────
# O falsifica.sh roda o lab 6x (uma por sabotagem) e cada sabotagem so pode ser vista por alguns
# cenarios: rodar os nove em todas e' pagar ~2,5x por informacao que ja se tem. `LAB_CENARIOS`
# recorta — e o C0 entra SEMPRE, porque e' o controle que separa "a guarda caiu" de "o lab caiu".
# O subconjunto vai IMPRESSO no cabecalho: run recortado que se passasse por completo seria
# cobertura que some sozinha, e o verde continuaria chegando.
CENARIOS="${LAB_CENARIOS:-C1 C2 C3 C4 C5 C6 C7 C8 C9 C10 C11 C12 C13 C14 C15 C16}"
quer() { case " C0 $CENARIOS " in *" $1 "*) return 0 ;; esac; return 1; }

echo "── lab retry PGDG · alvo: ${YML#"$RAIZ_REPO"/} · cenarios: C0 $CENARIOS ──"

# C0 — CONTROLE. Sem sabotagem: verde, uma chamada por camada, NENHUMA re-tentativa no log e as
# fontes base INTOCADAS (o E20 inteiro: o caminho normal nao depende do mirror do Ubuntu).
# Sem esta linha de base, os cenarios seguintes nao provam nada: um lab sempre-vermelho
# "detectaria" toda sabotagem, e um sempre-verde aprovaria todas.
roda
verde "C0 controle — sem falha, step verde"
espera_conta CURL 1   "C0 controle — curl chamado 1x"
espera_conta APTPGDG 1 "C0 controle — apt-get update do PGDG chamado 1x"
espera_conta APTBASE 0 "C0 controle — fontes base NAO atualizadas (o mirror do Ubuntu fica fora)"
espera_conta APTINS 1 "C0 controle — apt-get install chamado 1x"
espera_conta APTARQ 0 "C0 controle — pin no indice principal: apt-archive NAO consultado"
case "$(grep '^APTINS ' "$CONT/args" 2>/dev/null)" in
  *"postgresql-17=17.12-1.pgdg24.04+1 postgresql-client-17=17.12-1.pgdg24.04+1 postgresql-17-pgvector=0.8.7-1.pgdg24.04+2"*)
    passou "C0 controle — install com a versao COMPLETA resolvida do pin (rebuild mais novo)" ;;
  *) falhou "C0 controle — install sem as versoes pinadas: $(grep '^APTINS ' "$CONT/args" | head -1 | cut -c1-160)" ;;
esac
case "$SAIDA" in
  *"↻"*) falhou "C0 controle — logou re-tentativa sem nenhuma falha" ;;
  *) passou "C0 controle — zero re-tentativas no log" ;;
esac

# C1-C3 — RETENTA, uma camada por vez.
if quer C1; then
  roda LAB_CURL_FALHAS=1 LAB_CURL_EXIT=56
  verde "C1 curl transitorio (1 falha) — step verde"
  espera_conta CURL 2 "C1 curl transitorio — curl chamado 2x"
  case "$SAIDA" in
    *"↻ curl da chave do PGDG: OK na tentativa 2/3"*) passou "C1 curl transitorio — re-tentativa registrada no log" ;;
    *) falhou "C1 curl transitorio — verde, mas sem a linha de re-tentativa" ;;
  esac
fi

if quer C2; then
  roda LAB_APTPGDG_FALHAS=1 LAB_APTPGDG_EXIT=100
  verde "C2 apt-get update transitorio — step verde"
  espera_conta APTPGDG 2 "C2 apt-get update transitorio — chamado 2x"
  case "$SAIDA" in
    *"↻ apt-get update (só PGDG): OK na tentativa 2/3"*) passou "C2 apt-get update transitorio — re-tentativa registrada" ;;
    *) falhou "C2 apt-get update transitorio — verde, mas sem a linha de re-tentativa" ;;
  esac
fi

# C3 — o install falha 2x: a 1a decide o FALLBACK (update das fontes base, uma vez) e a 2a cai no
# retry do `tentar`, que acerta na 2a tentativa. Exercita os dois mecanismos novos do E20 juntos.
if quer C3; then
  roda LAB_APTINS_FALHAS=2 LAB_APTINS_EXIT=100
  verde "C3 apt-get install transitorio — step verde"
  espera_conta APTINS 3 "C3 apt-get install transitorio — chamado 3x (1 + fallback com retry)"
  espera_conta APTBASE 1 "C3 apt-get install transitorio — fallback atualizou as fontes base 1x"
  case "$SAIDA" in
    *"::warning::install só com o índice do PGDG falhou — fallback"*) passou "C3 fallback anunciado no log" ;;
    *) falhou "C3 fallback sem o ::warning:: no log" ;;
  esac
  case "$SAIDA" in
    *"↻ apt-get install postgresql-17 + pgvector: OK na tentativa 2/3"*) passou "C3 apt-get install transitorio — re-tentativa registrada" ;;
    *) falhou "C3 apt-get install transitorio — verde, mas sem a linha de re-tentativa" ;;
  esac
fi

# C4 — o teto e 3, nao 2: duas falhas seguidas ainda tem de virar verde na terceira.
if quer C4; then
  roda LAB_CURL_FALHAS=2 LAB_CURL_EXIT=56
  verde "C4 curl falha 2x — verde na terceira"
  espera_conta CURL 3 "C4 curl falha 2x — curl chamado 3x"
  case "$SAIDA" in
    *"OK na tentativa 3/3"*) passou "C4 curl falha 2x — terceira tentativa registrada" ;;
    *) falhou "C4 curl falha 2x — verde sem registrar a terceira" ;;
  esac
fi

# C5-C7 — DESISTE, uma camada por vez. Camada cuja permanente sai VERDE esta inalcancada.
if quer C5; then
  roda LAB_CURL_FALHAS=sempre LAB_CURL_EXIT=56
  vermelho "C5 curl PERMANENTE — reprova com o exit do curl" 56 "curl da chave do PGDG falhou nas 3 tentativas"
  espera_conta CURL 3 "C5 curl PERMANENTE — tentou 3x (e parou)"
  espera_conta APTPGDG 0 "C5 curl PERMANENTE — nao seguiu para o apt-get (fail-closed de verdade)"
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
fi

if quer C6; then
  roda LAB_APTPGDG_FALHAS=sempre LAB_APTPGDG_EXIT=100
  vermelho "C6 apt-get update PERMANENTE — reprova com o exit do apt" 100 "apt-get update (só PGDG) falhou nas 3 tentativas"
  espera_conta APTPGDG 3 "C6 apt-get update PERMANENTE — tentou 3x"
  espera_conta APTINS 0 "C6 apt-get update PERMANENTE — nao seguiu para o install"
  espera_conta APTBASE 0 "C6 apt-get update PERMANENTE — PGDG quebrado NAO cai no fallback (nao e o caso dele)"
fi

if quer C7; then
  roda LAB_APTINS_FALHAS=sempre LAB_APTINS_EXIT=100
  vermelho "C7 apt-get install PERMANENTE — reprova com o exit do apt" 100 "apt-get install postgresql-17 + pgvector falhou nas 3 tentativas"
  espera_conta APTINS 4 "C7 apt-get install PERMANENTE — 1 + 3 do retry pos-fallback"
fi

# C8 — exatamente 3 falhas: nao existe quarta tentativa. Separa "o teto e 3" de "o teto e alto".
if quer C8; then
  roda LAB_CURL_FALHAS=3 LAB_CURL_EXIT=56
  vermelho "C8 curl falha exatamente 3x — reprova (nao ha 4a tentativa)" 56 "falhou nas 3 tentativas"
  espera_conta CURL 3 "C8 curl falha 3x — curl chamado 3x"
fi

# C9 — ORCAMENTO e ESCOPO das chamadas de rede, num caminho que passa pelas TRES (install falha 1x,
# entao ha update do PGDG, install, update base e install de novo). Cada linha abaixo e' uma
# propriedade do E20 que o falsificador remove sozinha.
if quer C9; then
  roda LAB_APTINS_FALHAS=1 LAB_APTINS_EXIT=100
  verde "C9 caminho com fallback — step verde"
  args="$(cat "$CONT/args" 2>/dev/null)"
  pgdg="$(printf '%s\n' "$args" | grep '^APTPGDG ' || true)"
  case "$pgdg" in *"--error-on=any"*) passou "C9 update do PGDG com --error-on=any (aviso vira falha)" ;;
    *) falhou "C9 update do PGDG sem --error-on=any — W: sai 0 e o tentar nao ve" ;; esac
  case "$pgdg" in *"Dir::Etc::sourceparts=-"*) passou "C9 update do PGDG sem as outras fontes (sourceparts=-)" ;;
    *) falhou "C9 update do PGDG ainda le sources.list.d inteiro (o mirror volta ao caminho)" ;; esac
  case "$pgdg" in *"APT::Get::List-Cleanup=0"*) passou "C9 update do PGDG preserva os outros indices" ;;
    *) falhou "C9 update do PGDG sem List-Cleanup=0 — o apt apaga os indices das outras fontes" ;; esac
  if printf '%s\n' "$args" | grep -q 'timeout=nenhum'; then
    falhou "C9 chamada de apt-get SEM timeout: $(printf '%s\n' "$args" | grep 'timeout=nenhum' | head -1 | cut -c1-80)"
  else
    passou "C9 toda chamada de apt-get sob timeout ($(printf '%s\n' "$args" | grep -c .) chamadas)"
  fi
fi

# C10 — o FALLBACK tambem e' fail-closed: fontes base quebradas depois de um install falho REPROVAM
# com o exit do apt, sem retry (o teto de 240 s ja e' o orcamento dele) e sem um 2o install.
if quer C10; then
  roda LAB_APTINS_FALHAS=1 LAB_APTINS_EXIT=100 LAB_APTBASE_FALHAS=sempre LAB_APTBASE_EXIT=100
  vermelho "C10 fallback com fontes base PERMANENTE — reprova com o exit do apt" 100 "E: base: Temporary failure resolving"
  espera_conta APTBASE 1 "C10 fallback PERMANENTE — 1 chamada so (sem multiplicar a espera)"
  espera_conta APTINS 1 "C10 fallback PERMANENTE — nao tentou instalar de novo"
fi

# C11-C16 — o PIN (#3877). Cada um fecha um modo de falha do pin, nao do retry.
# C11 — pin que SAIU do indice principal: o apt-archive e' consultado UMA vez e a minor instala.
if quer C11; then
  roda PG17_MINOR=17.10
  verde "C11 pin fora do indice principal — verde pelo apt-archive" "PG17_PIN_OK minor=17.10"
  espera_conta APTARQ 1 "C11 apt-archive atualizado 1x"
  case "$SAIDA" in *"::warning::pin PG 17.10"*"consultando o apt-archive"*) passou "C11 fallback anunciado" ;;
    *) falhou "C11 fallback do apt-archive sem ::warning::" ;; esac
fi
# C12 — pin que nao existe em lugar nenhum: VERMELHO antes do install, dizendo o que corrigir.
if quer C12; then
  roda PG17_MINOR=17.99
  vermelho "C12 pin inexistente — reprova antes do install" 1 "não existe nem no apt-archive"
  espera_conta APTINS 0 "C12 pin inexistente — nao instalou nada"
fi
# C13 — `schedule`: pin IGNORADO, instala a mais nova do indice (e' o cron que acusa a minor nova).
if quer C13; then
  roda GITHUB_EVENT_NAME=schedule
  verde "C13 schedule — instala a mais nova sem pin" "(PostgreSQL) 17.13"
  case "$(grep "^APTINS " "$CONT/args" 2>/dev/null)" in *"postgresql-17="*) falhou "C13 schedule instalou com pin" ;;
    *) passou "C13 schedule — install sem '=' (sem pin)" ;; esac
  case "$SAIDA" in *"::notice::schedule sem pin instalou"*) passou "C13 schedule — versao nova no log (::notice::)" ;;
    *) falhou "C13 schedule sem o ::notice:: da versao" ;; esac
fi
# C14 — fora do schedule, pin VAZIO reprova (instalar a mais nova calado e' o que o pin fecha).
if quer C14; then
  roda PG17_MINOR=
  vermelho "C14 pin vazio fora do schedule — reprova" 1 "pin ausente"
  espera_conta APTINS 0 "C14 pin vazio — nao instalou nada"
fi
# C15 — apt-archive quebrado: fail-closed com o exit do apt, sob o mesmo retry.
if quer C15; then
  roda PG17_MINOR=17.10 LAB_APTARQ_FALHAS=sempre LAB_APTARQ_EXIT=100
  vermelho "C15 apt-archive PERMANENTE — reprova com o exit do apt" 100 "apt-get update (apt-archive do PGDG) falhou nas 3 tentativas"
  espera_conta APTARQ 3 "C15 apt-archive PERMANENTE — tentou 3x"
  espera_conta APTINS 0 "C15 apt-archive PERMANENTE — nao instalou"
fi
# C16 — o apt instalou OUTRA minor (17.1 nao pode casar 17.12): a conferencia POSITIVA reprova.
if quer C16; then
  roda LAB_INITDB_FORCA=17.1
  vermelho "C16 initdb de outra minor — reprova na conferencia do pin" 1 "não é a minor pinada 17.12"
fi

echo ""
echo "── resultado: $ok ok · $ruim falha(s) ──"
if [ "$ruim" -eq 0 ]; then echo "LAB-VERDE"; exit 0; fi
echo "LAB-VERMELHO"; exit 1
