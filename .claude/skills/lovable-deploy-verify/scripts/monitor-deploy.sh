#!/usr/bin/env bash
# monitor-deploy.sh — vigia se o frontend NO AR está sincronizado com origin/main.
# Pensado pra rodar em cron (sem interação): detecta um Publish (o hash do entry muda) e
# responde "ar == main?" pelo carimbo `__BUILD_SHA__` (vite.config + main.tsx), com FALLBACK
# de sentinela de string quando o carimbo não está disponível.
#
# SHA atrás NÃO é bundle atrás (2026-09-10, verificando o Publish do #2458): o ar servia
# eee71c80f, a main estava em 70fc305f3, e o único commit entre os dois (#2445) tocava docs/,
# scripts/, db/, CI, eval de skill e UMA entrada de `scripts` no package.json — o bundle que um
# Publish geraria era o mesmo, e o monitor mandava fazer Publish. Com ~30 worktrees mergeando
# docs/scripts o dia todo, o exit 3 cru ficava ligado quase sempre, e alarme que dispara com a
# resposta certa vira alarme ignorado. Quando ar ≠ main o monitor tenta PROVAR que o delta não
# alcança o bundle, elo a elo, e só rebaixa se TODOS responderem positivamente:
#   1. o `git fetch` desta rodada deu certo (main velha fabricaria o veredito);
#   2. o carimbo resolve para um commit local e ele é ANCESTRAL da main;
#   3. `git diff --no-renames --name-only ar main` sai 0 e lista ≥1 arquivo (sem --no-renames,
#      `git mv src/x.ts docs/` apareceria só como `docs/x.ts`);
#   4. todo arquivo do delta é INERTE (ou package.json) na tabela única de
#      `evals/classify.sh --bundle` — ALCANCA ou DESCONHECIDO seguram o alarme (lista fechada);
#   5. `alcance-bundle.py` prova, lendo a main, que nada do bundle importa de fora da tabela de
#      alcance, que o build é `vite build` puro e, se o package.json mudou, que só mudaram
#      scripts que o pipeline não executa (build, pre/post e ganchos de install ALCANÇAM).
# Elo sem resposta POSITIVA ⇒ ATRASADO (exit 3) com o motivo numa marca ASCII (linha "motivo:").
#
# Exit:  0 = sincronizado: o ar serve o MESMO commit da main (ou nada a relatar)
#        5 = SINCRONIZADO_EM_BUNDLE: SHA atrás por N commits, delta PROVADO fora do bundle —
#            Publish desnecessário. Não é 0 de propósito: "mesmo commit" ≠ "bundle equivalente",
#            e quem consome o exit precisa saber a diferença. No cron: avise em 2/3/4, NÃO em 5.
#        3 = ar ATRASADO (Publish pendente) — inclui "não consegui provar" (ver "motivo:")
#        4 = deploy novo detectado mas versão indeterminada (sem carimbo nem sentinela)
#        2 = site fora do ar / HTML mudou de forma
# Marcas do motivo (exit 3): ALCANCA_BUNDLE · SEM_CLASSIFICACAO · PACKAGE_JSON_ALCANCA ·
#   BUILD_NAO_RECONHECIDO · ALCANCE_VAZA · NAO_ANCESTRAL · CARIMBO_NAO_RESOLVE · FETCH_FALHOU ·
#   GIT_FALHOU · DIFF_FALHOU · DELTA_VAZIO · CLASSIFY_FALHOU · PROVA_INDISPONIVEL
# Estado: último hash de entry visto em $DEPLOY_MONITOR_STATE
#         (default ~/.config/afiacao/deploy-monitor.state) — pra detectar "mudou desde a última vez".
#
# Uso:   monitor-deploy.sh [url] [sentinela-opcional]
#   - rode com cwd DENTRO do repo (precisa de git pra saber o SHA de origin/main).
#   - SENTINELA: string única do HEAD que sobrevive ao build (ex.: um texto de UI),
#     usada SÓ se o carimbo vier "dev" (Lovable sem .git) ou ausente (build pré-carimbo).
#   - o exit 5 depende de git ≥ 2.28 e python3; sem eles o resultado é exit 3, nunca 5.
set -uo pipefail
APP="${1:-https://steu.lovable.app}"
SENTINELA="${2:-}"
STATE="${DEPLOY_MONITOR_STATE:-$HOME/.config/afiacao/deploy-monitor.state}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASSIFY="${DEPLOY_MONITOR_CLASSIFY:-$SELF_DIR/../evals/classify.sh}"
PROVA_PY="$SELF_DIR/alcance-bundle.py"
mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
TS=$(date +%FT%T 2>/dev/null || echo now)

if git fetch origin main --quiet 2>/dev/null; then FETCH_OK=1; else FETCH_OK=0; fi
MAIN_SHA=$(git rev-parse --short=8 origin/main 2>/dev/null || echo "?")

ENTRY=$(curl -fsS "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ -n "$ENTRY" ] || { echo "[$TS] monitor: $APP fora do ar ou HTML mudou de forma"; exit 2; }
ENTRY_HASH=$(printf '%s' "$ENTRY" | grep -oE 'index-[A-Za-z0-9_-]+')
PREV=$(cat "$STATE" 2>/dev/null || echo "")
printf '%s\n' "$ENTRY_HASH" > "$STATE"
if [ "$PREV" != "$ENTRY_HASH" ]; then DEPLOY="SIM (${PREV:-1a-vez} -> $ENTRY_HASH)"; else DEPLOY="nao"; fi

BODY=$(curl -fsS "$APP$ENTRY" 2>/dev/null || echo "")
AIR_SHA=$(printf '%s' "$BODY" | grep -oE '__BUILD_SHA__="[0-9a-f]{7,8}"' | grep -oE '[0-9a-f]{7,8}' | head -1)
IS_DEV=$(printf '%s' "$BODY" | grep -cE '__BUILD_SHA__="dev"' || true)

echo "[$TS] main=$MAIN_SHA  ar=${AIR_SHA:-$([ "${IS_DEV:-0}" -gt 0 ] && echo dev || echo sem-carimbo)}  deploy-novo=$DEPLOY"
[ "$FETCH_OK" = 1 ] || echo "  (git fetch origin main FALHOU nesta rodada: a main acima pode estar velha)"

# ATRASADO com o motivo numa marca ASCII — destino de TODO elo que não responde positivamente.
atrasado() {
  echo "  ⚠️ ATRASADO: ar serve $AIR_SHA, main em $MAIN_SHA → Publish pendente"
  echo "     motivo: $1 — $2"
  exit 3
}
eh_sha() { case "$1" in '' | *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; }

# SHA do ar ≠ SHA da main: prova (ou não) que o delta não alcança o bundle. Nunca retorna.
TMPD=""
analisar_delta() {
  local main_full ar_full anc n drc narq crc resumo cls qtd ex pkg="" prova prc
  main_full=$(git rev-parse --verify --quiet "origin/main^{commit}" 2>/dev/null) || main_full=""
  eh_sha "$main_full" || atrasado GIT_FALHOU "origin/main não resolve para um commit"
  ar_full=$(git rev-parse --verify --quiet "${AIR_SHA}^{commit}" 2>/dev/null) || ar_full=""
  # carimbo de 7 chars do MESMO commit: a comparação de string não enxerga, o SHA cheio sim
  if [ "$ar_full" = "$main_full" ]; then echo "  ✅ sincronizado: ar serve $AIR_SHA == origin/main"; exit 0; fi

  [ "$FETCH_OK" = 1 ] || atrasado FETCH_FALHOU "git fetch origin main falhou nesta rodada — a main local pode estar velha"
  # `<hex>^{commit}` também resolve NOME de ref (um branch chamado "abcdef12"): exija o prefixo
  case "$ar_full" in "$AIR_SHA"?*) eh_sha "$ar_full" ;; *) false ;; esac \
    || atrasado CARIMBO_NAO_RESOLVE "o carimbo $AIR_SHA não resolve para um commit local (ambíguo, fora da main ou não buscado)"
  git merge-base --is-ancestor "$ar_full" "$main_full" 2>/dev/null; anc=$?
  case "$anc" in
    0) ;;
    1) atrasado NAO_ANCESTRAL "o ar não é ancestral da main (divergiu ou é rollback) — o delta não descreve o que falta" ;;
    *) atrasado GIT_FALHOU "merge-base --is-ancestor saiu $anc" ;;
  esac
  n=$(git rev-list --count "$ar_full..$main_full" 2>/dev/null) || n=""
  case "$n" in '' | *[!0-9]* | 0) atrasado GIT_FALHOU "rev-list --count devolveu '$n'" ;; esac

  TMPD=$(mktemp -d 2>/dev/null) || atrasado GIT_FALHOU "mktemp falhou"
  trap 'rm -rf "$TMPD"' EXIT
  git -c core.quotePath=false diff --no-renames --no-relative --name-only "$ar_full" "$main_full" \
    > "$TMPD/delta" 2>/dev/null; drc=$?
  [ "$drc" -eq 0 ] || atrasado DIFF_FALHOU "git diff saiu $drc — a lista do delta não é confiável"
  narq=$(awk 'length($0) > 0 { n++ } END { print n + 0 }' "$TMPD/delta")
  [ "$narq" -gt 0 ] 2>/dev/null \
    || atrasado DELTA_VAZIO "git diff não listou nada para $n commit(s) — ausência de lista não é lista vazia"

  [ -f "$CLASSIFY" ] || atrasado CLASSIFY_FALHOU "classificador ausente: $CLASSIFY"
  bash "$CLASSIFY" --bundle < "$TMPD/delta" > "$TMPD/classes" 2>/dev/null; crc=$?
  [ "$crc" -eq 0 ] || atrasado CLASSIFY_FALHOU "classify.sh --bundle saiu $crc"
  # A marca de fim com a MESMA contagem é a resposta positiva do classificador: mudo, truncado
  # ou com linha estranha não pode virar "nenhum arquivo alcança o bundle".
  resumo=$(awk -F '\t' -v esperado="$narq" '
    $0 == "FIM_CLASSIFICACAO_BUNDLE " esperado { fim++; next }
    NF == 2 && $1 ~ /^(ALCANCA|PACKAGE_JSON|INERTE|DESCONHECIDO)$/ {
      n++; k[$1]++
      if ($1 != "INERTE" && k[$1] <= 3) ex[$1] = ex[$1] (k[$1] > 1 ? ", " : "") $2
      next
    }
    { lixo++ }
    END {
      if (fim != 1 || lixo || n != esperado) { print "MALFORMADO"; exit }
      if (k["ALCANCA"])      { printf "ALCANCA|%d|%s%s\n", k["ALCANCA"], ex["ALCANCA"], (k["ALCANCA"] > 3 ? ", ..." : ""); exit }
      if (k["DESCONHECIDO"]) { printf "DESCONHECIDO|%d|%s%s\n", k["DESCONHECIDO"], ex["DESCONHECIDO"], (k["DESCONHECIDO"] > 3 ? ", ..." : ""); exit }
      print (k["PACKAGE_JSON"] ? "PACKAGE_JSON" : "INERTE")
    }' "$TMPD/classes")
  IFS='|' read -r cls qtd ex <<< "$resumo"
  case "$cls" in
    ALCANCA)      atrasado ALCANCA_BUNDLE "$qtd arquivo(s) do delta alcançam o bundle: $ex" ;;
    DESCONHECIDO) atrasado SEM_CLASSIFICACAO "$qtd arquivo(s) sem classificação provada (a lista de inertes é fechada): $ex" ;;
    PACKAGE_JSON) pkg="--package-json" ;;
    INERTE)       ;;
    *)            atrasado CLASSIFY_FALHOU "saída do classify.sh --bundle malformada ou truncada" ;;
  esac

  prova=$(PYTHONIOENCODING=utf-8 python3 "$PROVA_PY" --ar "$ar_full" --main "$main_full" \
    --classify "$CLASSIFY" ${pkg:+"$pkg"} 2> "$TMPD/prova.err"); prc=$?
  case "$prc:$prova" in
    *$'\n'*) atrasado PROVA_INDISPONIVEL "alcance-bundle.py respondeu mais de uma linha" ;;
    "0:PROVA_INERCIA_OK "*) ;; # a ÚNICA porta para o exit 5: exit 0 E a marca positiva
    "1:PACKAGE_JSON_ALCANCA "* | "1:BUILD_NAO_RECONHECIDO "* | "1:ALCANCE_VAZA "*)
      atrasado "${prova%% *}" "${prova#* }" ;;
    *) atrasado PROVA_INDISPONIVEL "alcance-bundle.py saiu $prc sem prova positiva: ${prova:-$(head -c 160 "$TMPD/prova.err" 2>/dev/null | tr '\n' ' ')}" ;;
  esac

  echo "  ✅ SINCRONIZADO_EM_BUNDLE (SHA atrás por $n commit(s) sem efeito no frontend): ar serve $AIR_SHA, main em $MAIN_SHA"
  echo "     delta: $narq arquivo(s), nenhum alcança o bundle → Publish desnecessário"
  echo "     prova: ${prova#PROVA_INERCIA_OK }"
  exit 5
}

# Caminho determinístico: carimbo de SHA real no ar
if [ -n "$AIR_SHA" ]; then
  if [ "$AIR_SHA" = "$MAIN_SHA" ]; then echo "  ✅ sincronizado: ar serve $AIR_SHA == origin/main"; exit 0; fi
  analisar_delta
fi

# Fallback: carimbo "dev" (Lovable sem git no build) ou ausente (build pré-carimbo)
if [ -n "$SENTINELA" ]; then
  if "$SELF_DIR/verify-frontend.sh" "$SENTINELA" "$APP" >/dev/null 2>&1; then
    echo "  fallback: sentinela '$SENTINELA' PRESENTE no ar → provavelmente sincronizado"; exit 0
  else
    echo "  fallback: sentinela '$SENTINELA' AUSENTE → Publish pendente (ou sentinela ruim)"; exit 3
  fi
fi
if [ "$DEPLOY" = "nao" ]; then echo "  sem carimbo útil e nada mudou desde a última checagem → nada a relatar"; exit 0; fi
echo "  deploy novo detectado, mas sem carimbo de SHA nem sentinela → não dá pra confirmar a versão"
echo "  (quando o carimbo chegar ao ar no 1º Publish, este fallback some)"
exit 4
