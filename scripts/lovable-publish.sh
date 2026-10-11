#!/usr/bin/env bash
# lovable-publish.sh — Publish do frontend no Lovable pela API, com o GATE de ordem da casa.
#
# Chamado pelo .github/workflows/lovable-publish.yml a cada push na main; roda à mão também.
# Por que existe: "merge ≠ produção" (docs/agent/deploy.md) — o Publish era um clique que ficava
# para trás, e `steu.lovable.app` servia o build velho até alguém lembrar.
#
# O MARCADOR é o próprio ar: o commit que `steu.lovable.app` SERVE (carimbo `__BUILD_SHA__` que o
# vite injeta no entry — src/main.tsx). Nada de tag nem de "último run verde": um run RETIDO que
# terminasse verde faria a migration sumir do intervalo seguinte (challenge Codex, 2026-10-11), e
# um Publish manual (MCP `deploy_project`) se reconcilia sozinho, porque o ar é o que ele mudou.
#
# Passos:
#   1. lê o SHA servido (AR); exige 1 carimbo, resolvível, ancestral de HEAD;
#   2. intervalo AR..HEAD tocou supabase/migrations/ ou supabase/functions/ → RETIDO: o Publish
#      leva a main INTEIRA, e front novo sobre RPC/edge não aplicada quebra em runtime (ordem
#      DDL → edges → Publish). Libera-se só para UM SHA (LP_LIBERAR_SHA == HEAD), nunca "force";
#   3. intervalo sem nada publicável (só docs/.github/.claude/scripts/db/supabase/*.md) → nada;
#   4. espera o workspace do Lovable chegar em HEAD (`latest_commit_sha`); main andou → SUPERADO;
#   5. POST /publish {"name":"steu"} (name = slug de PROD — outro valor muda o endereço) e
#      acompanha o deployment;
#   6. PROVA pelo ar: o carimbo servido tem de virar HEAD. Se virou um DESCENDENTE (o bot/um merge
#      entrou entre o passo 4 e o 5 — consulta+POST não é atômico), re-julga HEAD..servido.
#
# Exit (última linha do stdout: `VEREDITO=<MARCA>`):
#   0  PUBLICADO · PUBLICADO_ADIANTE · JA_NO_AR · NADA_A_PUBLICAR · SUPERADO
#   10 RETIDO — camada de banco/edge pendente no intervalo (não é falha; o workflow abre Issue)
#   20 AMBIGUO — pode ter publicado e não sei (503, sem deployment id, status sem desfecho).
#      O workflow TRAVA os runs seguintes até alguém reconciliar (fechar a Issue).
#   21 FALHOU — não publicou, ou o ar não trocou para o SHA pedido
#   22 PUBLICOU_NAO_AVALIADO — o ar foi para um commit além de HEAD que traz camada pendente
#   6  MECANICA — não consegui MEDIR (carimbo, git, API, sync). Nunca vira "publicado".
#
# Ambiente: LOVABLE_API_KEY (obrigatório) · LOVABLE_PROJECT_ID · APP_URL · LOVABLE_API_BASE ·
#   LP_LIBERAR_SHA · LP_ESPERA_SYNC/LP_ESPERA_DEPLOY/LP_ESPERA_AR (s) · LP_SLEEP (testes).
# Uso: scripts/lovable-publish.sh [<sha-head>]
# Teste: scripts/test-lovable-publish.sh
set -u

PROJETO=${LOVABLE_PROJECT_ID:-8f005805-000a-42b7-88a1-9683f785fab6}
APP=${APP_URL:-https://steu.lovable.app}
API=${LOVABLE_API_BASE:-https://api.lovable.dev}
VERSAO_API=2026-09-11
SLUG=steu
ESPERA_SYNC=${LP_ESPERA_SYNC:-300}
ESPERA_DEPLOY=${LP_ESPERA_DEPLOY:-600}
ESPERA_AR=${LP_ESPERA_AR:-300}
DORME=${LP_SLEEP:-sleep}
CAMADAS='^supabase/(migrations|functions)/'
INERTE='^(docs/|\.github/|\.claude/|scripts/|db/|supabase/)|^[^/]+\.md$'

TMP=$(mktemp -d) || exit 6
trap 'rm -rf "$TMP"' EXIT

fim() { echo "VEREDITO=$2"; exit "$1"; }
mecanica() { echo "  motivo: $1"; fim 6 MECANICA; }

[ -n "${LOVABLE_API_KEY:-}" ] || mecanica "LOVABLE_API_KEY ausente"
command -v jq >/dev/null || mecanica "jq ausente"
HEAD_SHA=$(git rev-parse --verify "${1:-HEAD}^{commit}" 2>/dev/null) || mecanica "HEAD não resolve: ${1:-HEAD}"

# api <método> <caminho> [corpo] → grava o corpo em $TMP/resp, ecoa o HTTP code (000 = sem resposta)
api() {
  local args=(-sS -o "$TMP/resp" -w '%{http_code}' --max-time 30 -X "$1" "$API$2"
    -H "Lovable-API-Key: $LOVABLE_API_KEY" -H "Lovable-Version: $VERSAO_API" -H 'Accept: application/json')
  [ $# -ge 3 ] && args+=(-H 'Content-Type: application/json' --data "$3")
  : > "$TMP/resp"
  curl "${args[@]}" 2>/dev/null || true
}

# sha_no_ar → ecoa o SHA COMPLETO que o ar serve; rc≠0 com o motivo no stdout
sha_no_ar() {
  local entry corpo curtos n
  entry=$(curl -fsS --max-time 20 "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
  [ -n "$entry" ] || { echo "SITE_FORA: $APP sem /assets/index-*.js"; return 1; }
  corpo=$(curl -fsS --max-time 30 "$APP$entry" 2>/dev/null) || { echo "ENTRY_NAO_BAIXOU: $entry"; return 1; }
  curtos=$(printf '%s' "$corpo" | grep -oE '__BUILD_SHA__="[0-9a-f]{7,40}"' | grep -oE '[0-9a-f]{7,40}' | sort -u)
  n=$(printf '%s' "$curtos" | grep -c . || true)
  [ "$n" = 1 ] || { echo "CARIMBO_INVALIDO: $n carimbos em $entry"; return 1; }
  git rev-parse --verify --quiet "$curtos^{commit}" 2>/dev/null || { echo "CARIMBO_NAO_RESOLVE: $curtos"; return 1; }
}

# camadas <de> <até> → lista arquivos de migration/edge no intervalo (vazio = limpo); rc≠0 = git falhou
camadas() {
  git diff --name-only "$1" "$2" > "$TMP/diff" 2>/dev/null || return 1
  grep -E "$CAMADAS" "$TMP/diff" || true
}

# ── 1. o que o ar serve ────────────────────────────────────────────────────────────────────────
AR=$(sha_no_ar) || mecanica "$AR"
echo "ar=${AR:0:8} head=${HEAD_SHA:0:8} app=$APP"
[ "$AR" = "$HEAD_SHA" ] && fim 0 JA_NO_AR
git merge-base --is-ancestor "$AR" "$HEAD_SHA" 2>/dev/null \
  || mecanica "NAO_ANCESTRAL: o ar (${AR:0:8}) não é ancestral de HEAD — reconciliar à mão"

# ── 2. gate de ordem ───────────────────────────────────────────────────────────────────────────
PEND=$(camadas "$AR" "$HEAD_SHA") || mecanica "DIFF_FALHOU ${AR:0:8}..${HEAD_SHA:0:8}"
if [ -n "$PEND" ]; then
  LIB=$(git rev-parse --verify --quiet "${LP_LIBERAR_SHA:-x}^{commit}" 2>/dev/null || true)
  if [ "$LIB" = "$HEAD_SHA" ]; then
    echo "LIBERADO para ${HEAD_SHA:0:8} por LP_LIBERAR_SHA (atestação humana: camadas aplicadas)"
  else
    echo "Camadas no intervalo ${AR:0:8}..${HEAD_SHA:0:8} (aplicar ANTES do Publish — DDL → edges):"
    printf '%s\n' "$PEND" | sed 's/^/  - /'
    echo "Commits:"
    git log --format='  - %h %s' "$AR..$HEAD_SHA" -- supabase/migrations supabase/functions
    fim 10 RETIDO
  fi
fi

# ── 3. há algo publicável? ─────────────────────────────────────────────────────────────────────
if ! grep -qvE "$INERTE" "$TMP/diff"; then fim 0 NADA_A_PUBLICAR; fi

# ── 4. workspace do Lovable em HEAD ────────────────────────────────────────────────────────────
t=0
while :; do
  code=$(api GET "/v1/projects/$PROJETO")
  ws=$(jq -r '.latest_commit_sha // empty' "$TMP/resp" 2>/dev/null || true)
  [ "$code" = 200 ] && [ "$ws" = "$HEAD_SHA" ] && break
  remota=$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
  if [ -n "$remota" ] && [ "$remota" != "$HEAD_SHA" ]; then
    echo "main andou para ${remota:0:8} — o run desse commit decide"; fim 0 SUPERADO
  fi
  [ "$t" -ge "$ESPERA_SYNC" ] && mecanica "SYNC_NAO_CHEGOU: workspace em '${ws:0:8}' (HTTP $code) após ${ESPERA_SYNC}s"
  "$DORME" 10; t=$((t + 10))
done

# ── 5. Publish ─────────────────────────────────────────────────────────────────────────────────
code=$(api POST "/v1/projects/$PROJETO/publish" "{\"name\":\"$SLUG\"}")
DEP=$(jq -r '.id // empty' "$TMP/resp" 2>/dev/null || true)
case "$code" in
  202|200) [ -n "$DEP" ] || { echo "  POST $code sem deployment id"; fim 20 AMBIGUO; } ;;
  4??) echo "  POST recusado (HTTP $code): $(head -c 300 "$TMP/resp")"; fim 21 FALHOU ;;
  *) echo "  POST sem desfecho (HTTP $code) — pode ter publicado: $(head -c 300 "$TMP/resp")"; fim 20 AMBIGUO ;;
esac
echo "deployment=$DEP"

t=0; passo=2
while :; do
  code=$(api GET "/v1/projects/$PROJETO/publish/$DEP")
  st=$(jq -r '.status // empty' "$TMP/resp" 2>/dev/null || true)
  [ "$code" = 200 ] && [ "$st" = completed ] && break
  if [ "$code" = 200 ] && [ "$st" = error ]; then
    echo "  deployment error: $(jq -r '"\(.error_class // "?"): \(.error_message // "?")"' "$TMP/resp")"
    fim 21 FALHOU
  fi
  [ "$t" -ge "$ESPERA_DEPLOY" ] && { echo "  deployment sem desfecho após ${ESPERA_DEPLOY}s (HTTP $code, status '$st')"; fim 20 AMBIGUO; }
  "$DORME" "$passo"; t=$((t + passo)); [ "$passo" -lt 10 ] && passo=$((passo + 2))
done

# ── 6. prova pelo ar ───────────────────────────────────────────────────────────────────────────
t=0
while :; do
  NOVO=$(sha_no_ar) || NOVO=""
  [ -n "$NOVO" ] && [ "$NOVO" != "$AR" ] && break
  [ "$t" -ge "$ESPERA_AR" ] && { echo "  deployment completed, mas o ar segue em ${AR:0:8} após ${ESPERA_AR}s"; fim 21 FALHOU; }
  "$DORME" 10; t=$((t + 10))
done
echo "ar agora=${NOVO:0:8}"
[ "$NOVO" = "$HEAD_SHA" ] && fim 0 PUBLICADO
if git merge-base --is-ancestor "$HEAD_SHA" "$NOVO" 2>/dev/null; then
  EXTRA=$(camadas "$HEAD_SHA" "$NOVO") || mecanica "DIFF_FALHOU ${HEAD_SHA:0:8}..${NOVO:0:8}"
  [ -z "$EXTRA" ] && fim 0 PUBLICADO_ADIANTE
  echo "  o ar foi para ${NOVO:0:8}, além do avaliado, trazendo camadas:"
  printf '%s\n' "$EXTRA" | sed 's/^/  - /'
  fim 22 PUBLICOU_NAO_AVALIADO
fi
echo "  o ar foi para ${NOVO:0:8}, que não é HEAD nem descendente dele"
fim 21 FALHOU
