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
#   2. intervalo BASE..HEAD tocou supabase/migrations/ ou supabase/functions/ → RETIDO: o Publish
#      leva a main INTEIRA, e front novo sobre RPC/edge não aplicada quebra em runtime (ordem
#      DDL → edges → Publish). BASE = AR, ou a atestação mais nova que seja ancestral de HEAD
#      (LP_LIBERAR_SHA; no --decidir também `piso`/`liberar`) — 40 hex, nunca "force";
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
# Uso: scripts/lovable-publish.sh [--julgar] [<sha-head>]
#   --julgar: roda SÓ os passos 1-3 (sem API, sem chave) e sai `VEREDITO=PUBLICAR` (exit 0) quando
#   haveria Publish — é o tick barato do vigia local (scripts/lovable-vigia.sh), que publica pelo MCP.
#
#   --esperar <sha>: NÃO publica. Loop barato (shell, sem LLM, sem chave) para a sessão que acabou
#   de mergear: a cada LP_ESPERAR_INTERVALO s (45) lê o carimbo servido e sai quando o ar CONTÉM
#   <sha> (`git merge-base --is-ancestor <sha> <servido>`; `git fetch` se o servido não for local).
#   Entre leituras, re-julga `--julgar origin/main` e lê o estado do vigia ($LP_VIGIA_ESTADO,
#   default o do lovable-vigia.sh) para distinguir "só demora" de "não vai sair sozinho".
#   Prazo: LP_ESPERAR_PRAZO s (1800, contado em intervalos dormidos — aproximado). Uso canônico:
#   Bash com run_in_background (docs/agent/deploy.md, Camada 2). Exit (última linha estável):
#     0  NO_AR=<sha servido>          — o ar contém <sha>
#     0  NADA_A_PUBLICAR=<sha servido> — ar..main só tem inerte (docs/scripts/db): não haverá Publish,
#                                        e o front de <sha> já é o do ar
#     10 RETIDO=<migration|edge>:<arquivo> — migration sem `liberar` no vigia, ou edge que o ledger
#                                        diz não servida (pendencias:deploy=1): aplicar a camada
#     30 TIMEOUT                       — prazo estourou sem o ar conter <sha> (fila? Mac dormindo?)
#     30 TIMEOUT=vigia parado há N min — idem, e o `batimento` do vigia está velho (> LP_BATIMENTO_VELHO_S, 300)
#     6  MECANICA=<motivo>             — <sha> não resolve / não está na main, ou nunca medi o ar
#   --decidir <sha>: a DECISÃO ÚNICA do vigia e do --esperar (sem API, sem chave, só LÊ o estado em
#   $LP_ESTADO — default o diretório do vigia). É o --julgar + a política de liberação:
#     - base das camadas = o mais novo, ancestral de <sha>, entre AR, `piso` (camadas já atestadas
#       numa decisão anterior) e `liberar` (atestação humana — cobre SÓ migrations; edge é sempre do
#       ledger a partir de ar/piso) — só SHA de 40 hex resolvível;
#     - migration em base..<sha> → RETIDO (imprime `RETIDO=migration:<arq>` e o comando de liberação);
#     - só edge → o ledger (`pendencias-<sha>` gravado pelo vigia, válido LP_CACHE_EDGE_MIN=15 min):
#       0 = liberado · 1 = `RETIDO=edge:<arq>` · ausente/vencido = PRECISA_LEDGER (exit 11). `_shared` vai
#       ao ledger quando toda consumidora está no mapa (`shared-<base>-<sha>`, sonda-fan-out --prova-ledger);
#       consumidora fora do mapa, ou edge sem `versao.ts`: só `liberar` sem mudança nela depois;
#     - migration sem atestação → RECIBOS (`recibos-<ar>-<sha>`, scripts/lovable-recibos.sh, válido
#       LP_CACHE_RECIBO_MIN=5 min): todas aplicada/adiada = liberado · sem_recibo/desconhecido =
#       RETIDO · ausente/vencido = PRECISA_RECIBOS (exit 12);
#     - camadas atestadas até <sha> → imprime `PISO=<sha>` (o vigia grava; o próximo PR não re-trava).
#   --liberar <sha>: grava a atestação humana ($LP_ESTADO/liberar, atômico). Exige 40 hex e ancestral
#   da origin/main; mostra a main medida e as migrations que a liberação cobre. Vale para todo
#   descendente sem migration nova depois dele (`git diff <sha> <main> -- supabase/migrations` vazio).
#
#   Camadas que NÃO retêm: `supabase/functions/**/*_test.ts` e `supabase/functions/**/*.md`.
#   Intervalo sem nada publicável → NADA_A_PUBLICAR mesmo com camada pendente (ninguém espera o
#   Publish; a camada segue no intervalo do próximo PR, porque o marcador é o ar).
# Teste: scripts/test-lovable-publish.sh
set -u

case "${1:-}" in -h|--help) sed -n '2,/^set -u$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;; esac

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
NAO_CAMADA='^supabase/functions/.*(_test\.ts|\.md)$'   # teste e doc de edge não vão a produção
ESTADO=${LP_ESTADO:-${LP_VIGIA_ESTADO:-$HOME/.local/state/afiacao/lovable-vigia}}
CACHE_EDGE_MIN=${LP_CACHE_EDGE_MIN:-15}
CACHE_RECIBO_MIN=${LP_CACHE_RECIBO_MIN:-5}
INERTE='^(docs/|\.github/|\.claude/|scripts/|db/|supabase/)|^[^/]+\.md$'

# nomes com acento saem entre aspas no git por padrão (core.quotePath) e escapariam dos casamentos
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.quotePath GIT_CONFIG_VALUE_0=false
TMP=$(mktemp -d) || exit 6
trap 'rm -rf "$TMP"' EXIT

fim() { echo "VEREDITO=$2"; exit "$1"; }
mecanica() { echo "  motivo: $1"; fim 6 MECANICA; }

JULGAR=0; DECIDIR=0; ESPERAR=""; LIBERAR=""
case "${1:-}" in
  --julgar) JULGAR=1; shift ;;
  --decidir) JULGAR=1; DECIDIR=1; shift ;;
  --esperar) [ -n "${2:-}" ] || { echo "MECANICA=uso: --esperar <sha>"; exit 6; }; ESPERAR=$2; shift 2 ;;
  --liberar) LIBERAR=${2:-}; [ -n "$LIBERAR" ] || LIBERAR=vazio; shift; shift 2>/dev/null || true ;;
esac

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
  local entry corpo curtos n visto
  entry=$(curl -fsS --max-time 20 "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
  [ -n "$entry" ] || { echo "SITE_FORA: $APP sem /assets/index-*.js"; return 1; }
  corpo=$(curl -fsS --max-time 30 "$APP$entry" 2>/dev/null) || { echo "ENTRY_NAO_BAIXOU: $entry"; return 1; }
  curtos=$(printf '%s' "$corpo" | grep -oE '__BUILD_SHA__="[0-9a-f]{7,40}"' | grep -oE '[0-9a-f]{7,40}' | sort -u)
  n=$(printf '%s' "$curtos" | grep -c . || true)
  # o que o bundle TRAZ no lugar (rodada 2, B1): sem isto o log de 27/11 só dizia "0 carimbos" e o asset sumiu (404)
  if [ "$n" != 1 ]; then
    visto=$(printf '%s' "$corpo" | grep -oE '__BUILD_SHA__.{0,24}' | head -2 | tr '\n' ' ' | tr -d '"' | cut -c1-80)
    echo "CARIMBO_INVALIDO: $n carimbos em $entry (visto: ${visto:-nenhum __BUILD_SHA__})"; return 1
  fi
  git rev-parse --verify --quiet "$curtos^{commit}" 2>/dev/null || { echo "CARIMBO_NAO_RESOLVE: $curtos"; return 1; }
}

# camadas <de> <até> → lista arquivos de migration/edge no intervalo (vazio = limpo); rc≠0 = git falhou
camadas() {
  git diff --no-renames --name-only "$1" "$2" > "$TMP/cam" 2>/dev/null || return 1
  grep -E "$CAMADAS" "$TMP/cam" | grep -vE "$NAO_CAMADA" || true
}
# sha40 <texto> → ecoa o commit se o texto for EXATAMENTE 40 hex resolvível (liberação/piso)
sha40() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] && git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null; }

# ── --liberar <sha>: a atestação humana, validada aqui e de novo em toda decisão ────────────────
if [ -n "$LIBERAR" ]; then
  L=$LIBERAR
  [[ "$L" =~ ^[0-9a-f]{40}$ ]] || { echo "RECUSADO: '$L' não é SHA de 40 hex (nada de HEAD, ramo ou abreviado)"; exit 2; }
  git fetch -q origin 2>/dev/null || echo "  (fetch falhou — julgo pela origin/main local)"
  MAIN=$(git rev-parse --verify --quiet 'origin/main^{commit}') || { echo "RECUSADO: origin/main não resolve"; exit 6; }
  git rev-parse --verify --quiet "$L^{commit}" >/dev/null || { echo "RECUSADO: $L não existe neste clone"; exit 2; }
  git merge-base --is-ancestor "$L" "$MAIN" || { echo "RECUSADO: ${L:0:8} não é ancestral da origin/main (${MAIN:0:8})"; exit 2; }
  echo "main medida agora: ${MAIN:0:8} — $(git log -1 --format='%cd · %s' --date=format:'%d/%m %H:%M' "$MAIN" | cut -c1-90)"
  if AR=$(sha_no_ar) && git merge-base --is-ancestor "$AR" "$L" 2>/dev/null; then
    echo "ar=${AR:0:8} · migrations que esta atestação cobre (${AR:0:8}..${L:0:8}):"
    git diff --name-only "$AR" "$L" -- supabase/migrations | sed 's/^/  - /'
  else echo "  (não li o ar ou ele não é ancestral de ${L:0:8} — não listo o intervalo)"; fi
  DEPOIS=$(git diff --name-only "$L" "$MAIN" -- supabase/migrations)
  [ -z "$DEPOIS" ] || { echo "ATENÇÃO: a main já tem migration DEPOIS de ${L:0:8} — esta liberação NÃO a cobre:"; printf '%s\n' "$DEPOIS" | sed 's/^/  - /'; }
  if ! { mkdir -p "$ESTADO" && printf '%s\n' "$L" > "$ESTADO/liberar.tmp.$$" && mv -f "$ESTADO/liberar.tmp.$$" "$ESTADO/liberar"; }; then
    echo "MECANICA: não gravei $ESTADO/liberar"; exit 6
  fi
  echo "LIBERAR=$L gravado em $ESTADO/liberar"; exit 0
fi

# ── --esperar <sha>: só OBSERVA o ar (nunca publica) ───────────────────────────────────────────
if [ -n "$ESPERAR" ]; then
  PRAZO=${LP_ESPERAR_PRAZO:-1800}; PASSO=${LP_ESPERAR_INTERVALO:-45}
  VIGIA=$ESTADO
  sai() { echo "$2"; exit "$1"; }
  diz() { [ "$1" = "${dito:-}" ] || echo "  $1"; dito=$1; }   # loga só quando o estado MUDA
  # carimbo de commit que este clone ainda não tem (merge recente) → fetch e relê uma vez
  ar_lido() { local r; r=$(sha_no_ar) && { echo "$r"; return 0; }
    case "$r" in CARIMBO_NAO_RESOLVE*) git fetch -q origin 2>/dev/null; sha_no_ar ;; *) echo "$r"; return 1 ;; esac; }
  resolve() { git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null; }
  PEDIDO=$(resolve "$ESPERAR") || { git fetch -q origin 2>/dev/null; PEDIDO=$(resolve "$ESPERAR"); } \
    || sai 6 "MECANICA=SHA_NAO_RESOLVE:$ESPERAR"
  echo "esperando o ar conter ${PEDIDO:0:8} (prazo ${PRAZO}s, leitura a cada ${PASSO}s) app=$APP"
  t=0; mediu=0; falha=""
  while :; do
    if AR=$(ar_lido); then
      mediu=1
      git merge-base --is-ancestor "$PEDIDO" "$AR" 2>/dev/null && sai 0 "NO_AR=$AR"
      TIPO=$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
      [ -n "$TIPO" ] && { resolve "$TIPO" >/dev/null || git fetch -q origin 2>/dev/null; }
      if [ -z "$TIPO" ] || ! resolve "$TIPO" >/dev/null; then
        diz "ar=${AR:0:8} · main remota ilegível agora — sigo esperando"
      elif ! git merge-base --is-ancestor "$PEDIDO" "$TIPO" 2>/dev/null; then
        # a main só cresce: fora dela agora = nunca (ex.: SHA do ramo, não o do squash)
        sai 6 "MECANICA=FORA_DA_MAIN:${PEDIDO:0:8} não é ancestral de origin/main (${TIPO:0:8}) — passe o SHA do merge"
      else
        # a MESMA decisão do tick do vigia (mesmo estado, mesmo cache de edge), só leitura
        # o decisor é o da main MEDIDA (uma sessão com worktree velho não decide com regra velha)
        DEC="$0"; git show "$TIPO:scripts/lovable-publish.sh" > "$TMP/decisor.sh" 2>/dev/null \
          && grep -q -- '--decidir' "$TMP/decisor.sh" && DEC="$TMP/decisor.sh"
        J=$(LP_LIBERAR_SHA='' LP_ESTADO="$VIGIA" bash "$DEC" --decidir "$TIPO" 2>&1); jrc=$?
        ARF=$(printf '%s\n' "$J" | sed -n 's/^AR=//p' | head -1)   # o ar que a decisão MEDIU
        VER=$(printf '%s\n' "$J" | tail -1 | sed -n 's/^VEREDITO=//p')
        case "$jrc:$VER" in
          10:RETIDO)
            printf '%s\n' "$J" | grep -E '^  (liberar:|liberado para SHA antigo|liberar .* (ignorado|ultrapassado))' || true
            sai 10 "$(printf '%s\n' "$J" | grep -m1 '^RETIDO=' || echo RETIDO=?)" ;;
          0:NADA_A_PUBLICAR)
            [ -n "$ARF" ] || ARF=$AR
            git merge-base --is-ancestor "$PEDIDO" "$ARF" 2>/dev/null && sai 0 "NO_AR=$ARF"
            # nada a publicar até a main, mas o front do pedido difere do ar → foi revertido sem sair
            git diff --no-renames --name-only "$ARF" "$PEDIDO" 2>/dev/null | grep -qvE "$INERTE" \
              && sai 6 "MECANICA=FRONT_SUPERADO:${PEDIDO:0:8} nunca vai ao ar — a main reverteu o front dele (ar=${ARF:0:8})"
            sai 0 "NADA_A_PUBLICAR=$ARF" ;;
          0:PUBLICAR) diz "ar=${AR:0:8} main=${TIPO:0:8} · liberado ($(printf '%s\n' "$J" | sed -n 's/^LIBERADO=//p' | head -1)) — aguardando o Publish do vigia" ;;
          12:PRECISA_RECIBOS) diz "ar=${AR:0:8} · migration no intervalo; o vigia ainda não leu os recibos do db:aplicar (ou o cache venceu)" ;;
          11:PRECISA_LEDGER) diz "ar=${AR:0:8} · só edge no intervalo; o vigia ainda não consultou o ledger (ou o cache venceu)" ;;
          *) diz "ar=${AR:0:8} main=${TIPO:0:8} · decidir: ${VER:-?} (rc $jrc) — sigo esperando" ;;
        esac
      fi
    else
      falha=$AR; diz "leitura do ar falhou: $AR"
    fi
    if [ "$t" -ge "$PRAZO" ]; then
      [ "$mediu" = 1 ] || sai 6 "MECANICA=AR_ILEGIVEL:$falha"
      # batimento do vigia (rodada 2, M6): velho = o vigia não está rodando, não é "só demora"
      B=$(head -1 "$VIGIA/batimento" 2>/dev/null)
      case "$B" in ''|*[!0-9]*) sai 30 TIMEOUT ;; esac
      P=$(( $(date +%s) - B ))
      [ "$P" -gt "${LP_BATIMENTO_VELHO_S:-300}" ] && sai 30 "TIMEOUT=vigia parado há $((P / 60)) min (sem batimento em $VIGIA/batimento)"
      sai 30 TIMEOUT
    fi
    "$DORME" "$PASSO"; t=$((t + PASSO))
  done
fi

[ "$JULGAR" = 1 ] || [ -n "${LOVABLE_API_KEY:-}" ] || mecanica "LOVABLE_API_KEY ausente"
command -v jq >/dev/null || mecanica "jq ausente"
HEAD_SHA=$(git rev-parse --verify "${1:-HEAD}^{commit}" 2>/dev/null) || mecanica "HEAD não resolve: ${1:-HEAD}"

# ── 1. o que o ar serve ────────────────────────────────────────────────────────────────────────
# Carimbo ausente/inválido (rodada 2, B1): no --decidir, com LP_AR_FALLBACK = o último ar MEDIDO (o vigia grava
# `ar-ultimo` a cada leitura boa e só o passa depois de N ticks seguidos sem carimbo), julga as camadas a partir
# dele — o gate inteiro segue valendo — e não aceita JA_NO_AR nem NADA_A_PUBLICAR: o servido é desconhecido, e
# republicar a main é o que conserta o carimbo. Só CARIMBO_INVALIDO: site fora/entry que não baixa seguem MECANICA.
FALLBACK=0
if ! AR=$(sha_no_ar); then
  case "$AR" in
    CARIMBO_INVALIDO*)
      if [ "$DECIDIR" = 1 ] && [ -n "${LP_AR_FALLBACK:-}" ] && FB=$(sha40 "$LP_AR_FALLBACK"); then
        echo "  ar sem carimbo válido ($AR) — julgo a partir do último ar medido ${FB:0:8}; republicar conserta o carimbo"
        echo "AR_FALLBACK=$FB"; AR=$FB; FALLBACK=1
      else mecanica "$AR"; fi ;;
    *) mecanica "$AR" ;;
  esac
fi
echo "ar=${AR:0:8} head=${HEAD_SHA:0:8} app=$APP"
[ "$DECIDIR" = 1 ] && echo "AR=$AR"
[ "$AR" = "$HEAD_SHA" ] && [ "$FALLBACK" = 0 ] && fim 0 JA_NO_AR   # sem PISO: carimbo igual prova o front, não a migration
git merge-base --is-ancestor "$AR" "$HEAD_SHA" 2>/dev/null \
  || mecanica "NAO_ANCESTRAL: o ar (${AR:0:8}) não é ancestral de HEAD — reconciliar à mão"
git diff --name-only "$AR" "$HEAD_SHA" > "$TMP/diff" 2>/dev/null || mecanica "DIFF_FALHOU ${AR:0:8}..${HEAD_SHA:0:8}"

# ── 2. gate de ordem ────────────────────────────────────────────────────────────────────────────
# MIGRATIONS: limpas se ALGUMA atestação c (ar, LP_LIBERAR_SHA; no --decidir também `liberar` e
#   `piso`) for 40 hex, ancestral de HEAD e sem migration em c..HEAD — cada uma testada sozinha
#   (piso e liberar podem ser incomparáveis entre si: ramos irmãos unidos por merge).
# EDGES: sempre de AR..HEAD (ou LP_LIBERAR_SHA, a atestação humana do workflow) — no --decidir a
#   única prova é o ledger FRESCO para HEAD; piso e liberar não cobrem edge (o ledger vale 15 min,
#   uma edge pode sofrer rollback depois).
FONTE=""
atestacao() {  # atestacao <texto> <fonte> → 0 se cobre as migrations até HEAD
  local s m; s=$(sha40 "$1") || { echo "  $2 '$(printf '%s' "$1" | head -c 45)' ignorado: não é SHA de 40 hex resolvível"; return 1; }
  git merge-base --is-ancestor "$s" "$HEAD_SHA" 2>/dev/null || { echo "  $2 ${s:0:8} ignorado: não é ancestral de ${HEAD_SHA:0:8}"; return 1; }
  m=$(camadas "$s" "$HEAD_SHA") || return 1
  printf '%s\n' "$m" | grep -q '^supabase/migrations/' && return 1
  [ "$s" = "$AR" ] || FONTE="$2 ${s:0:8}"
  return 0
}
BASE_E=$AR
if [ -n "${LP_LIBERAR_SHA:-}" ] && L=$(sha40 "$LP_LIBERAR_SHA") && git merge-base --is-ancestor "$AR" "$L" 2>/dev/null \
   && git merge-base --is-ancestor "$L" "$HEAD_SHA" 2>/dev/null; then BASE_E=$L; fi
LIB_ARQ=""; PISO_ARQ=""
if [ "$DECIDIR" = 1 ]; then
  LIB_ARQ=$(head -1 "$ESTADO/liberar" 2>/dev/null || true)
  PISO_ARQ=$(head -1 "$ESTADO/piso" 2>/dev/null || true)
fi
MIG_OK=0
atestacao "$AR" ar && MIG_OK=1
[ "$MIG_OK" = 0 ] && [ -n "${LP_LIBERAR_SHA:-}" ] && atestacao "$LP_LIBERAR_SHA" LP_LIBERAR_SHA && MIG_OK=1
[ "$MIG_OK" = 0 ] && [ -n "$LIB_ARQ" ] && atestacao "$LIB_ARQ" liberar && MIG_OK=1
[ "$MIG_OK" = 0 ] && [ -n "$PISO_ARQ" ] && atestacao "$PISO_ARQ" piso && MIG_OK=1
CA=$(camadas "$AR" "$HEAD_SHA") || mecanica "DIFF_FALHOU ${AR:0:8}..${HEAD_SHA:0:8}"
CE=$(camadas "$BASE_E" "$HEAD_SHA") || mecanica "DIFF_FALHOU ${BASE_E:0:8}..${HEAD_SHA:0:8}"
PEND=$( { [ "$MIG_OK" = 1 ] || printf '%s\n' "$CA" | grep '^supabase/migrations/'; printf '%s\n' "$CE" | grep '^supabase/functions/'; } || true)
[ -n "$FONTE" ] && echo "migrations atestadas até ${HEAD_SHA:0:8} por $FONTE — ar=${AR:0:8}"
BASE=$AR

# ── 3. há algo publicável? (antes do RETIDO: sem front novo, ninguém espera o Publish) ───────────
if [ "$FALLBACK" = 0 ] && ! grep -qvE "$INERTE" "$TMP/diff"; then
  if [ -n "$PEND" ]; then echo "  camadas pendentes (${BASE:0:8}..${HEAD_SHA:0:8}), mas nada publicável — seguem no intervalo do próximo PR"
  elif [ "$DECIDIR" = 1 ] && [ -n "$FONTE" ]; then echo "PISO=$HEAD_SHA"; fi
  fim 0 NADA_A_PUBLICAR
fi

retido() {  # retido <tipo> <arquivo>
  echo "Camadas pendentes até ${HEAD_SHA:0:8} (ar=${AR:0:8}; aplicar ANTES do Publish — DDL → edges):"
  printf '%s\n' "$PEND" | sed 's/^/  - /'
  echo "Commits:"
  git log --format='  - %h %s' "$BASE_E..$HEAD_SHA" -- supabase/migrations supabase/functions
  if [ "$1" = migration ]; then
    if [ -n "${LIB_ARQ:-}" ] && L=$(sha40 "$LIB_ARQ") && [ "$L" != "$HEAD_SHA" ] \
       && git merge-base --is-ancestor "$L" "$HEAD_SHA" 2>/dev/null; then
      # rodada 2, B3: um liberar que o ar já passou não é "liberado para SHA antigo" — não cobre nada
      if [ "$L" != "$AR" ] && git merge-base --is-ancestor "$L" "$AR" 2>/dev/null; then
        echo "  liberar ${L:0:8} ultrapassado: o ar (${AR:0:8}) já o contém — não cobre nada (o vigia o apaga)"
      else
        echo "  liberado para SHA antigo ${L:0:8} — migration(s) depois dele até ${HEAD_SHA:0:8}:"
        git diff --name-only "$L" "$HEAD_SHA" -- supabase/migrations 2>/dev/null | sed 's/^/      /'
      fi
    fi
    echo "  liberar: aplique a(s) migration(s) e rode  bash scripts/lovable-publish.sh --liberar $HEAD_SHA"
  fi
  echo "RETIDO=$1:$2"
  fim 10 RETIDO
}
LIBS=()   # o que liberou, para a linha LIBERADO=
[ -n "$FONTE" ] && LIBS+=("$FONTE")
MIG=$(printf '%s\n' "$PEND" | grep -m1 '^supabase/migrations/' || true)
if [ -n "$MIG" ]; then
  [ "$DECIDIR" = 1 ] || retido migration "$MIG"
  # RECIBO de banco (o vigia grava pelo scripts/lovable-recibos.sh; psql-ro em db_aplicacoes e
  # db_migracoes_adiadas, pelo SHA-256 dos bytes de HEAD). Cache por (ar, head): o ar muda o conjunto.
  # base dos recibos: o MAIS NOVO entre ar, liberar e piso (ancestrais de HEAD) — o que o humano
  # já cobriu não volta a exigir recibo (Codex PR2 #6: migration do SQL Editor liberada à mão).
  # Nunca um liberar/piso MAIS VELHO que o ar: o PEND já parte do ar, e um liberar de dias atrás
  # re-exigia recibo de migration já servida (aplicada fora do envelope) e travava TODO recibo
  # dali em diante (liberar 39ea6374 de 26/11 × 2 sem_recibo de 27/11: recibo nunca liberou).
  RB=$AR
  for cand in "$LIB_ARQ" "$PISO_ARQ"; do
    c=$(sha40 "$cand" 2>/dev/null) && git merge-base --is-ancestor "$c" "$HEAD_SHA" 2>/dev/null \
      && git merge-base --is-ancestor "$RB" "$c" 2>/dev/null && RB=$c
  done
  echo "RECIBOS_DE=$RB"
  REC="$ESTADO/recibos-$RB-$HEAD_SHA"
  if [ -z "$(find "$REC" -mmin "-$CACHE_RECIBO_MIN" 2>/dev/null)" ]; then
    echo "  migration em ${RB:0:8}..${HEAD_SHA:0:8} sem atestação; recibos sem leitura válida (< ${CACHE_RECIBO_MIN} min)"
    fim 12 PRECISA_RECIBOS
  fi
  sed -n '2,$p' "$REC" | sed 's/^/  recibo: /'
  case "$(head -1 "$REC")" in
    0) LIBS+=("recibos"); PEND=$(printf '%s\n' "$PEND" | grep '^supabase/functions/' || true) ;;
    1) retido migration "$MIG" ;;
    2) echo "  recibo DESCONHECIDO (tentativa sem desfecho, ou não li o ledger) — não libero: confira com bun run db:aplicar"
       retido migration "$MIG" ;;
    *) mecanica "RECIBOS_ILEGIVEIS: $REC" ;;
  esac
fi
if [ -n "$PEND" ]; then
  EDG=$(printf '%s\n' "$PEND" | head -1)
  [ "$DECIDIR" = 1 ] || retido edge "$EDG"
  # edge que o ledger NÃO prova por si: _shared (muda toda edge sem mexer na versão dela — provado à parte,
  # abaixo) ou função sem versao.ts (a sonda não sabe o que está servido). Sem prova, só atestação humana
  # (liberar) sem mudança depois.
  SEMV=$(printf '%s\n' "$PEND" | while read -r e; do
    fn=$(printf '%s' "$e" | cut -d/ -f3)
    if [ "$fn" = _shared ] || ! git cat-file -e "$HEAD_SHA:supabase/functions/$fn/versao.ts" 2>/dev/null; then echo "$e"; fi
  done)
  # `_shared/` pelo LEDGER (rodada 2, M1): o `fonte` do mapa é o hash do fecho com `_shared/` dentro, então o
  # `pendencias:deploy` já prova a mudança para toda edge DO MAPA. A prova de que toda consumidora do arquivo
  # está no mapa (e tem versao.ts) é do `sonda-fan-out.ts --prova-ledger`, que o vigia grava em
  # `shared-<base>-<head>` (validade LP_CACHE_EDGE_MIN). 0 = o _shared sai daqui e segue para o ledger; qualquer
  # outra coisa (consumidora fora do mapa, fecho ilegível, mecânica) = liberar humano, como antes.
  SH=$(printf '%s\n' "$SEMV" | grep '^supabase/functions/_shared/' || true)
  if [ -n "$SH" ]; then
    echo "PROVA_DE=$BASE_E"
    PROVA="$ESTADO/shared-$BASE_E-$HEAD_SHA"
    if [ -z "$(find "$PROVA" -mmin "-$CACHE_EDGE_MIN" 2>/dev/null)" ]; then
      echo "  _shared em ${BASE_E:0:8}..${HEAD_SHA:0:8}; prova do fecho (sonda-fan-out --prova-ledger) sem leitura válida (< ${CACHE_EDGE_MIN} min)"
      fim 11 PRECISA_LEDGER
    fi
    if [ "$(head -1 "$PROVA")" = 0 ]; then
      echo "  _shared provado pelo ledger (toda consumidora no mapa de fingerprints):"
      sed -n '2,$p' "$PROVA" | sed 's/^/      /'
      SEMV=$(printf '%s\n' "$SEMV" | grep -v '^supabase/functions/_shared/' || true)
    else
      echo "  _shared que o ledger NÃO prova (consumidora fora do mapa/sem versao.ts, ou fecho ilegível):"
      sed -n '2,$p' "$PROVA" | grep -v '^LEDGER ' | sed 's/^/      /'
    fi
  fi
  if [ -n "$SEMV" ]; then
    L=""; [ -n "$LIB_ARQ" ] && L=$(sha40 "$LIB_ARQ" || true)
    # rodada 2, B3: só um liberar que o ar NÃO ultrapassou (ar ancestral dele) atesta edge sem versão
    [ -n "$L" ] && ! git merge-base --is-ancestor "$AR" "$L" 2>/dev/null && L=""
    # o DIRETÓRIO inteiro de cada função (Codex PR2 #5: um helper que volta aos bytes do ar some do
    # intervalo, mas a edge implantada em L usa a versão de L)
    DIRS=(); while read -r e; do DIRS+=("supabase/functions/$(printf '%s' "$e" | cut -d/ -f3)/"); done <<< "$SEMV"
    if [ -n "$L" ] && git merge-base --is-ancestor "$L" "$HEAD_SHA" 2>/dev/null \
       && D=$(git diff --no-renames --name-only "$L" "$HEAD_SHA" -- "${DIRS[@]}" 2>/dev/null) && [ -z "$D" ]; then
      LIBS+=("liberar ${L:0:8} (edge sem versao.ts/_shared)")
      PEND=$(printf '%s\n' "$PEND" | grep -vxF "$SEMV" || true)
    else
      echo "  edge que o ledger não prova (sem versao.ts ou _shared) — deploy dela e liberação humana:"
      printf '%s\n' "$SEMV" | sed 's/^/      /'
      echo "  liberar: faça o deploy e rode  bash scripts/lovable-publish.sh --liberar $HEAD_SHA"
      echo "RETIDO=edge:$(printf '%s\n' "$SEMV" | head -1)"
      fim 10 RETIDO
    fi
  fi
fi
if [ -n "$PEND" ]; then
  EDG=$(printf '%s\n' "$PEND" | head -1)
  # edge com versao.ts: o ledger deploy_atestacoes, pelo cache que o vigia grava (mesma validade para todos)
  CACHE="$ESTADO/pendencias-$HEAD_SHA"
  if [ -z "$(find "$CACHE" -mmin "-$CACHE_EDGE_MIN" 2>/dev/null)" ]; then
    echo "  edge em ${BASE_E:0:8}..${HEAD_SHA:0:8} (ar=${AR:0:8}); ledger sem leitura válida (< ${CACHE_EDGE_MIN} min) para ${HEAD_SHA:0:8}"
    fim 11 PRECISA_LEDGER
  fi
  case "$(head -1 "$CACHE")" in
    0) LIBS+=("ledger") ;;
    1) retido edge "$EDG" ;;
    *) mecanica "LEDGER_FALHOU: pendencias:deploy exit $(head -1 "$CACHE") — ver $ESTADO/pendencias.txt" ;;
  esac
fi
[ "${#LIBS[@]}" -gt 0 ] && echo "LIBERADO=$(IFS='+'; echo "${LIBS[*]}") ar=${AR:0:8}"
# piso = migrations atestadas até HEAD por HUMANO (liberar/piso anterior), nunca por carimbo nem por
# recibo (adiada é revogável: o recibo se relê a cada decisão, cache de LP_CACHE_RECIBO_MIN)
[ "$DECIDIR" = 1 ] && [ -n "$FONTE" ] && echo "PISO=$HEAD_SHA"
[ "$JULGAR" = 1 ] && fim 0 PUBLICAR

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
