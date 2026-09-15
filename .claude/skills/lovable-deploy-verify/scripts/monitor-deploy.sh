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
#   1. o `git fetch` desta rodada deu certo — pré-condição de TODO verde, não só deste (abaixo);
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
# Sem fetch, NENHUM verde (2026-09-10): o guard do elo 1 vivia só no caminho do exit 5, e com o
# `git fetch origin main` falho sobravam três portas para o exit 0 que comparavam o ar com a main
# LOCAL, possivelmente velha — a igualdade de string do carimbo, o atalho do SHA cheio (carimbo de
# 7 chars do mesmo commit) e o fallback sem carimbo ("nada a relatar", hoje 4). Ar == main velha e a main
# real já andou com `src/` ⇒ "sincronizado", com uma linha de aviso que o cron não lê (ele lê o
# EXIT). Agora FETCH_OK=0 ⇒ exit 3 FETCH_FALHOU ANTES de qualquer veredito: sem a main desta
# rodada não há "ar == main?", e ausência de dado não vira verde nem quando a resposta calharia de
# ser sim. Só o exit 2 (site fora do ar) é medido antes.
#
# Fetch que "dá certo" sem mover a ref (2026-09-14): `git fetch origin main` sai 0 e só atualiza
# refs/remotes/origin/main se o `remote.origin.fetch` configurado mapear a main — num clone
# `--single-branch` de outro branch só o FETCH_HEAD anda (medido: rc 0, ref parada no commit do ar,
# main real adiante com src/ ⇒ "sincronizado"). E o nome CURTO `origin/main` é resolvido por regra
# de nome: um branch LOCAL `origin/main` vence refs/remotes/, e o rev-parse devolvia o branch velho
# com o aviso "ambiguous" no stderr descartado. Agora é a MESMA ref completa nas duas pontas: o
# fetch NOMEIA o destino (+refs/heads/main:refs/remotes/origin/main — exit 0 ⇒ ela foi escrita
# NESTA rodada; destino travado ou remoto sem main saem ≠ 0 ⇒ FETCH_FALHOU) e toda leitura da main
# usa esse nome.
#
# Exit:  0 = sincronizado: o ar serve o MESMO commit da main (ou, sem carimbo, SENTINELA_PRESENTE)
#        5 = SINCRONIZADO_EM_BUNDLE: SHA atrás por N commits, delta PROVADO fora do bundle —
#            Publish desnecessário. Não é 0 de propósito: "mesmo commit" ≠ "bundle equivalente",
#            e quem consome o exit precisa saber a diferença. No cron: avise em tudo que NÃO for
#            0 ou 5 (2/3/4, e o 6 de uso inválido).
#        3 = ar ATRASADO (Publish pendente) — inclui "não consegui provar" (ver "motivo:")
#        4 = VERSAO_INDETERMINADA: sem carimbo nem sentinela o monitor não sabe QUAL commit o ar
#            serve — nos TRÊS estados do deploy-novo, marcados PRIMEIRA_CHECAGEM · ENTRY_NOVO ·
#            ENTRY_IGUAL. O ENTRY_IGUAL saía 0 "nada a relatar" até 2026-09-14 (levantado pelo Codex
#            na revisão do #2485): entry igual ao da última checagem prova que nada mudou NO AR, não
#            que o ar == main, e num checkout de cron em que o carimbo some o alarme soava UMA vez,
#            na troca, e depois se calava no código de "sincronizado" — com a main andando e o
#            Publish pendente. Agora o 4 se repete a cada rodada até o carimbo voltar (ou vir uma
#            sentinela); o --pr, no mesmo caso, sai 6 SEM_CARIMBO.
#        2 = site fora do ar / HTML mudou de forma / o entry não baixou
#        6 = USO_INVALIDO (argumento que não se entende — nunca vira veredito)
#        Fetch desta rodada falhou ⇒ nem 0, nem 5, nem 4: sai 3 FETCH_FALHOU (só o 2 e o 6 de uso
#        vêm antes). No --pr o mesmo fetch falho sai 6 (abaixo): lá "não sei" não é "atrasado".
# Marcas do motivo (exit 3): ALCANCA_BUNDLE · SEM_CLASSIFICACAO · PACKAGE_JSON_ALCANCA ·
#   BUILD_NAO_RECONHECIDO · ALCANCE_VAZA · NAO_ANCESTRAL · CARIMBO_NAO_RESOLVE · CARIMBO_AMBIGUO · FETCH_FALHOU ·
#   GIT_FALHOU · DIFF_FALHOU · DELTA_VAZIO · CLASSIFY_FALHOU · PROVA_INDISPONIVEL · SENTINELA_SEM_VEREDITO
#
# --pr <n> — OUTRA pergunta: "o PR n está no ar?" (2026-09-10, Publish do #2459: o #2445 mergeou
# 38 s depois do ANTES, e o "ATRASADO" seguiu com o #2459 JÁ servido — igualdade com a main não
# responde se UM PR está no ar). É ancestralidade: o SQUASH do PR (`gh pr view --json mergeCommit`,
# nunca o head do branch — o head do #2459 existia no clone e dava rc 1 LIMPO) na história do
# commit que o ar serve. Exit: 0 = PR_NO_AR · 3 = PR_FORA_DO_AR (o commit ainda não está no build;
# a linha PR_TOCA_O_BUNDLE / PR_SEM_ALCANCE_NO_BUNDLE diz se publicar muda algo para ele) ·
# 6 = NAO_CONSEGUI_MEDIR — rc≠0/1 do merge-base (128 = SHA que o clone não conhece), PR não
# mergeado, base ≠ main, gh ou fetch falhou, clone raso, sem carimbo. Nunca "fora do ar".
#
# Estado: último entry visto, POR CHECKOUT — `<git-dir deste checkout>/deploy-monitor.state` (cada
# worktree tem git-dir próprio, e o estado morre com ela). Até 2026-09-10 era UM arquivo na máquina
# (~/.config/afiacao/deploy-monitor.state), e uma sessão que nunca tinha rodado o monitor via
# `deploy-novo=nao` porque OUTRA gravara o entry novo. 1ª checagem = `?`, nunca "SIM".
# `DEPLOY_MONITOR_STATE` sobrescreve (aponte dois checkouts para o mesmo arquivo se QUISER partilhar).
#
# Uso:   monitor-deploy.sh [--pr <n>] [url] [sentinela-opcional]
#   - rode com cwd DENTRO do repo (precisa de git pra saber o SHA de origin/main; --pr usa o gh).
#   - url COM esquema: sem https:// o curl volta vazio e se leria como site caído (exit 6 agora).
#   - SENTINELA: string única do HEAD que sobrevive ao build (ex.: um texto de UI),
#     usada SÓ se o carimbo vier "dev" (Lovable sem .git) ou ausente (build pré-carimbo).
#     Não combina com --pr: sem carimbo, prove o PR pelo CONTEÚDO (verify-frontend.sh --pai).
#   - o exit 5 depende de git ≥ 2.28 e python3; sem eles o resultado é exit 3, nunca 5.
set -uo pipefail
uso() {
  echo "  uso: monitor-deploy.sh [--pr <n>] [url-com-https] [sentinela]"
  echo "  ❌ USO_INVALIDO: $1 — nada foi medido"
  exit 6
}
PR=""; MODO_PR=0; APP=""; SENTINELA=""; npos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)   [ $# -ge 2 ] || uso "--pr sem o número do PR"
            MODO_PR=1; PR="$2"; shift 2 ;;
    --pr=*) MODO_PR=1; PR="${1#--pr=}"; shift ;;
    -*)     uso "opção desconhecida: $1" ;;
    *)      npos=$((npos + 1))
            case "$npos" in 1) APP="$1" ;; 2) SENTINELA="$1" ;; *) uso "argumento a mais: '$1'" ;; esac
            shift ;;
  esac
done
APP="${APP:-https://steu.lovable.app}"
case "$APP" in http://*|https://*) ;; *) uso "url sem esquema: '$APP'" ;; esac
if [ "$MODO_PR" = 1 ]; then
  case "$PR" in ''|*[!0-9]*) uso "--pr exige o NÚMERO do PR (recebi '$PR')" ;; esac
  [ -z "$SENTINELA" ] || uso "--pr não combina com sentinela"
fi
GITDIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || GITDIR=""
STATE="${DEPLOY_MONITOR_STATE:-${GITDIR:+$GITDIR/deploy-monitor.state}}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASSIFY="${DEPLOY_MONITOR_CLASSIFY:-$SELF_DIR/../evals/classify.sh}"
PROVA_PY="$SELF_DIR/alcance-bundle.py"
TS=$(date +%FT%T 2>/dev/null || echo now)

# destino NOMEADO no fetch e o mesmo nome completo em toda leitura da main (ver cabeçalho)
REF_MAIN=refs/remotes/origin/main
if git fetch --quiet origin "+refs/heads/main:$REF_MAIN" 2>/dev/null; then FETCH_OK=1; else FETCH_OK=0; fi
MAIN_SHA=$(git rev-parse --short=8 "$REF_MAIN" 2>/dev/null || echo "?")

ENTRY=$(curl -fsS "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ -n "$ENTRY" ] || { echo "[$TS] monitor: $APP fora do ar ou HTML mudou de forma"; exit 2; }
ENTRY_HASH=$(printf '%s' "$ENTRY" | grep -oE 'index-[A-Za-z0-9_-]+')
# Linha `<entry> <ts> <url>`: url diferente = sem estado anterior. O formato ANTIGO (só o entry, de
# um DEPLOY_MONITOR_STATE apontado à mão antes de 2026-09-10) vale como valia: quem apontou escolheu
# partilhar — o monitor-deploy-eval.sh semeia assim o cenário do fallback sem carimbo.
PREV=""; PREV_TS=""; PREV_URL=""
if [ -n "$STATE" ] && [ -f "$STATE" ]; then read -r PREV PREV_TS PREV_URL < "$STATE" || true; fi
if [ -n "$PREV" ] && [ -z "$PREV_TS" ] && [ -z "$PREV_URL" ]; then PREV_TS="formato-antigo"; PREV_URL="$APP"; fi
if [ -z "$PREV" ] || [ "$PREV_URL" != "$APP" ]; then DEPLOY="? (1a checagem deste checkout nesta url)"
elif [ "$PREV" = "$ENTRY_HASH" ]; then DEPLOY="nao (vs. $PREV_TS, neste checkout)"
else DEPLOY="SIM ($PREV -> $ENTRY_HASH, desde $PREV_TS)"; fi
# Gravar é auxiliar: se falhar, só a detecção de deploy novo degrada (e é DITO) — o veredito de SHA não.
if [ -z "$STATE" ] || ! { mkdir -p "$(dirname "$STATE")" \
     && printf '%s %s %s\n' "$ENTRY_HASH" "$TS" "$APP" > "$STATE.$$" && mv -f "$STATE.$$" "$STATE"; } 2>/dev/null; then
  rm -f "$STATE.$$" 2>/dev/null
  DEPLOY="$DEPLOY [AVISO_ESTADO_NAO_GRAVADO: ${STATE:-sem git-dir}]"
fi

BODY=$(curl -fsS "$APP$ENTRY" 2>/dev/null || echo "")
# Entry que não baixa não é "sem carimbo": seguir daqui leria ausência de dado como resposta.
[ -n "$BODY" ] || { echo "[$TS] monitor: ENTRY_NAO_BAIXOU — o entry $ENTRY de $APP não veio; nada a ler"; exit 2; }
AIR_SHA=$(printf '%s' "$BODY" | grep -oE '__BUILD_SHA__="[0-9a-f]{7,8}"' | grep -oE '[0-9a-f]{7,8}' | head -1)
# Carimbos DISTINTOS no entry: com mais de um, "o primeiro" é arbitrário — um literal
# `__BUILD_SHA__="<hex>"` qualquer no código viraria o SHA do ar (medido 2026-09-10: 1 no ar, 0 em src/).
N_CARIMBOS=$(printf '%s' "$BODY" | grep -oE '__BUILD_SHA__="[0-9a-f]{7,8}"' | sort -u | awk 'END { print NR }')
IS_DEV=$(printf '%s' "$BODY" | grep -cE '__BUILD_SHA__="dev"' || true)

AR_ROTULO=${AIR_SHA:-$([ "${IS_DEV:-0}" -gt 0 ] && echo dev || echo sem-carimbo)}
echo "[$TS] main=$MAIN_SHA  ar=$AR_ROTULO  deploy-novo=$DEPLOY"

# ATRASADO com o motivo numa marca ASCII — destino de TODO elo que não responde positivamente.
atrasado() {
  echo "  ⚠️ ATRASADO: ar serve $AR_ROTULO, main em $MAIN_SHA → Publish pendente"
  echo "     motivo: $1 — $2"
  exit 3
}
eh_sha() { case "$1" in '' | *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; }

# SHA do ar ≠ SHA da main: prova (ou não) que o delta não alcança o bundle. Nunca retorna.
TMPD=""
analisar_delta() {
  local main_full ar_full anc n drc narq crc resumo cls qtd ex pkg="" prova prc
  main_full=$(git rev-parse --verify --quiet "$REF_MAIN^{commit}" 2>/dev/null) || main_full=""
  eh_sha "$main_full" || atrasado GIT_FALHOU "origin/main não resolve para um commit"
  ar_full=$(git rev-parse --verify --quiet "${AIR_SHA}^{commit}" 2>/dev/null) || ar_full=""
  # carimbo de 7 chars do MESMO commit: a comparação de string não enxerga, o SHA cheio sim
  if [ "$ar_full" = "$main_full" ]; then echo "  ✅ sincronizado: ar serve $AIR_SHA == origin/main"; exit 0; fi

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

# ── --pr <n>: "o PR n está no ar?" — ANCESTRALIDADE, não igualdade ──────────────────────────────
# Todo "não sei" sai por nao_consegui (exit 6): rc 128 lido como 1, PR não mergeado ou clone raso
# fabricariam "fora do ar" com cara de veredito.
nao_consegui() { # MARCA mensagem
  echo "  ❌ NAO_CONSEGUI_MEDIR ($1): $2"
  echo "     Isto NÃO é veredito: nem 'no ar' nem 'fora do ar'."
  exit 6
}
curto() { printf '%s' "$1" | cut -c1-9; }
# Alcance do PRÓPRIO PR (pai..squash) pela MESMA tabela (`classify.sh --bundle`) e pela MESMA prova
# (`alcance-bundle.py`) do analisar_delta: PR fora do ar que só toca docs não é "Publish pendente".
# Informativo — nunca muda o exit; sem resposta completa diz PR_ALCANCE_NAO_PROVADO, nunca "sem alcance".
alcance_do_pr() {
  local pai lista classes n nb nd np pkg="" prova prc
  pai=$(git rev-parse --verify --quiet "$PR_SQUASH^1^{commit}" 2>/dev/null) \
    || { echo "     PR_ALCANCE_NAO_PROVADO: o squash não tem pai resolvível"; return; }
  # flags em outra ordem DE PROPÓSITO: a sequência no-renames→no-relative do analisar_delta é alvo de sabotagem do
  # monitor-deploy-eval.sh no analisar_delta, e alvo repetido faz o harness dele recusar a sabotagem.
  lista=$(git -c core.quotePath=false diff --no-relative --no-renames --name-only "$pai" "$PR_SQUASH" 2>/dev/null) \
    || { echo "     PR_ALCANCE_NAO_PROVADO: git diff do squash falhou"; return; }
  n=$(printf '%s\n' "$lista" | awk 'length($0) > 0 { n++ } END { print n + 0 }')
  [ "$n" -gt 0 ] || { echo "     PR_ALCANCE_NAO_PROVADO: o squash não lista arquivo nenhum"; return; }
  classes=$(printf '%s\n' "$lista" | bash "$CLASSIFY" --bundle 2>/dev/null) || classes=""
  case "$classes
" in
    *"FIM_CLASSIFICACAO_BUNDLE $n
"*) ;;
    *) echo "     PR_ALCANCE_NAO_PROVADO: classify.sh --bundle sem a marca de fim com os $n arquivo(s)"; return ;;
  esac
  nb=$(printf '%s\n' "$classes" | awk -F '\t' '$1 == "ALCANCA" { n++ } END { print n + 0 }')
  nd=$(printf '%s\n' "$classes" | awk -F '\t' '$1 == "DESCONHECIDO" { n++ } END { print n + 0 }')
  np=$(printf '%s\n' "$classes" | awk -F '\t' '$1 == "PACKAGE_JSON" { n++ } END { print n + 0 }')
  if [ "$nb" -gt 0 ]; then
    echo "     PR_TOCA_O_BUNDLE: $nb de $n arquivo(s) do #$PR alcançam o bundle — para ele, falta Publish: $(printf '%s\n' "$classes" \
      | awk -F '\t' '$1 == "ALCANCA" && k < 3 { printf "%s%s", (k++ ? ", " : ""), $2 }')"
    return
  fi
  if [ "$nd" -gt 0 ]; then
    echo "     PR_ALCANCE_NAO_PROVADO: $nd arquivo(s) do #$PR sem classificação provada (a lista de inertes é fechada)"
    return
  fi
  [ "$np" -eq 0 ] || pkg="--package-json"
  prova=$(PYTHONIOENCODING=utf-8 python3 "$PROVA_PY" --ar "$pai" --main "$PR_SQUASH" --classify "$CLASSIFY" \
    ${pkg:+"$pkg"} 2>/dev/null); prc=$?
  case "$prc:$prova" in
    *$'\n'*) echo "     PR_ALCANCE_NAO_PROVADO: alcance-bundle.py respondeu mais de uma linha" ;;
    "0:PROVA_INERCIA_OK "*)
      echo "     PR_SEM_ALCANCE_NO_BUNDLE: nenhum dos $n arquivo(s) do #$PR alcança o bundle — publicar não muda nada para ele" ;;
    *) echo "     PR_ALCANCE_NAO_PROVADO: ${prova:-alcance-bundle.py saiu $prc sem prova positiva}" ;;
  esac
}
# Ancestralidade prova que o commit entrou na HISTÓRIA do build, não que o CONTEÚDO sobreviveu: um
# revert entre o squash e o ar dá PR_NO_AR com a mudança fora do ar. Revert do GitHub cita
# "Reverts <repo>#N"; o `git revert` cita o SHA. AVISA e nunca muda o exit — heurística de mensagem.
avisa_revert() {
  local r
  r=$(git log --format='%h %s' -i -E --grep="revert.*#${PR}([^0-9]|\$)" \
        --grep="$(printf '%s' "$PR_SQUASH" | cut -c1-12)" "$PR_SQUASH..$AR_FULL" 2>/dev/null | head -3)
  [ -z "$r" ] || echo "     ⚠️ AVISO_REVERT_POSTERIOR: commit(s) entre o squash e o ar citam o #$PR ou o squash — confira se o conteúdo segue lá: $(printf '%s' "$r" | tr '\n' ';')"
}
veredito_pr_no_ar() {
  echo "  ✅ PR_NO_AR: o squash $(curto "$PR_SQUASH") do #$PR está na história de $AIR_SHA, o commit que o ar serve"
  echo "     (prova que o commit entrou no build — não que o conteúdo sobreviveu a um revert posterior)"
  avisa_revert
  exit 0
}
veredito_pr_fora_do_ar() {
  echo "  ⚠️ PR_FORA_DO_AR: o squash $(curto "$PR_SQUASH") do #$PR NÃO está na história de $AIR_SHA — o ar é build de antes dele"
  alcance_do_pr
  exit 3
}
if [ "$MODO_PR" = 1 ]; then
  [ "$FETCH_OK" = 1 ] || nao_consegui FETCH_FALHOU "git fetch origin main falhou nesta rodada — no --pr isso é fail-CLOSED: a ancestralidade seria medida num clone que não conferiu a main"
  [ "${N_CARIMBOS:-0}" -le 1 ] || nao_consegui CARIMBO_AMBIGUO "o entry tem $N_CARIMBOS carimbos __BUILD_SHA__ distintos — não dá para saber qual commit o ar serve"
  [ -n "$AIR_SHA" ] || nao_consegui SEM_CARIMBO "o ar não carimba SHA (dev ou ausente) — ancestralidade exige o commit do ar; prove o PR pelo CONTEÚDO (verify-frontend.sh --pai, Passo 4)"
  # O carimbo vira UM commit com o prefixo conferido (mesma regra do analisar_delta: um branch
  # chamado "abcdef12" sequestraria o `^{commit}`).
  AR_FULL=$(git rev-parse --verify --quiet "${AIR_SHA}^{commit}" 2>/dev/null) || AR_FULL=""
  case "$AR_FULL" in "$AIR_SHA"?*) eh_sha "$AR_FULL" ;; *) false ;; esac \
    || nao_consegui SHA_DESCONHECIDO "o ar serve $AIR_SHA, que este clone não resolve para UM commit (ausente, ou prefixo ambíguo)"
  # O SQUASH na main — NUNCA o head do branch: o head existe no clone e dá rc 1 LIMPO num PR que
  # está no ar (medido no #2459: head a93c101ee → 1, squash eee71c80f → 0).
  GH_ERR=$(mktemp 2>/dev/null) || nao_consegui GH_FALHOU "mktemp falhou"
  GH_OUT=$(GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 gh pr view "$PR" --json state,mergeCommit,baseRefName \
             --jq '[.state, (.mergeCommit.oid // "-"), .baseRefName] | @tsv' 2>"$GH_ERR"); GH_RC=$?
  GH_MSG=$(tr '\n' ' ' < "$GH_ERR" | cut -c1-160); rm -f "$GH_ERR"
  [ "$GH_RC" -eq 0 ] || nao_consegui GH_FALHOU "gh pr view $PR saiu $GH_RC: $GH_MSG"
  IFS=$'\t' read -r PR_STATE PR_SQUASH PR_BASE <<EOF
$GH_OUT
EOF
  echo "  pr=#$PR  estado=${PR_STATE:-?}  squash=$(curto "${PR_SQUASH:--}")  base=${PR_BASE:-?}"
  if [ "${PR_STATE:-}" != "MERGED" ] || ! eh_sha "${PR_SQUASH:-}"; then
    nao_consegui PR_NAO_MERGEADO "o #$PR veio '${PR_STATE:-?}' com mergeCommit '${PR_SQUASH:--}' — sem squash na main não há o que procurar no ar"
  fi
  [ "${PR_BASE:-}" = "main" ] || nao_consegui PR_BASE_NAO_E_MAIN "o #$PR mergeou em '${PR_BASE:-?}', não na main — o ar é build da main"
  # Clone RASO: a ancestralidade para na borda e devolve rc 1 LIMPO. Exige a resposta POSITIVA
  # "false" — git que não conhece a flag responde outra coisa, e isso também é "não sei".
  [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "false" ] \
    || nao_consegui CLONE_RASO "clone raso: a ancestralidade para na borda e devolveria rc 1 FALSO — rode 'git fetch --unshallow' e repita"
  git merge-base --is-ancestor "$PR_SQUASH" "$AR_FULL" 2>/dev/null; rc_pr=$?
  case "$rc_pr" in
    0) veredito_pr_no_ar ;;
    1) veredito_pr_fora_do_ar ;;
    *) nao_consegui SHA_DESCONHECIDO "merge-base --is-ancestor saiu $rc_pr para o squash $(curto "$PR_SQUASH") do #$PR × o ar $AIR_SHA (squash ausente do clone?) — rc≠0/1 é 'não sei', nunca 'fora do ar'" ;;
  esac
fi

# Elo 1 vale para TODO veredito, não só para o delta: sem o fetch desta rodada a origin/main local
# pode estar velha, e sem a main não há "ar == main?" — nem por igualdade de string, nem pelo atalho
# do SHA cheio, nem pelo fallback. Guard ÚNICO e ANTES de tudo: dentro de um caminho, ele deixava os
# outros abertos (era o caso até 2026-09-10 — ver cabeçalho). O --pr, logo acima, já saiu: ele
# responde OUTRA pergunta e trata o fetch falho no próprio bloco, com exit 6 (não consegui medir).
[ "$FETCH_OK" = 1 ] || atrasado FETCH_FALHOU "git fetch origin main falhou nesta rodada — a main acima é a LOCAL e pode estar velha; sem ela não há verde"

# Caminho determinístico: carimbo de SHA real no ar — e UM só (ambíguo não pode virar verde nenhum)
[ "${N_CARIMBOS:-0}" -le 1 ] || atrasado CARIMBO_AMBIGUO "o entry tem $N_CARIMBOS carimbos __BUILD_SHA__ distintos — não dá para saber qual commit o ar serve"
if [ -n "$AIR_SHA" ]; then
  if [ "$AIR_SHA" = "$MAIN_SHA" ]; then echo "  ✅ sincronizado: ar serve $AIR_SHA == origin/main"; exit 0; fi
  analisar_delta
fi

# Fallback: carimbo "dev" (Lovable sem git no build) ou ausente (build pré-carimbo). O
# verify-frontend.sh tem QUATRO saídas, não duas: 0 presente · 1 ausente · 2 sonda não confiável ·
# 3 recusa. Até 2026-09-10 todo ≠0 virava "AUSENTE → Publish pendente" — o 2 e o 3 lidos como 1.
sentinela_presente() { echo "  fallback: SENTINELA_PRESENTE '$SENTINELA' no ar → provavelmente sincronizado"; exit 0; }
sentinela_ausente() { echo "  fallback: SENTINELA_AUSENTE '$SENTINELA' → Publish pendente (ou sentinela ruim)"; exit 3; }
if [ -n "$SENTINELA" ]; then
  VF_OUT=$("$SELF_DIR/verify-frontend.sh" "$SENTINELA" "$APP" 2>&1); VF_RC=$?
  [ "$VF_RC" -eq 0 ] || printf '%s\n' "$VF_OUT" | tail -n 6 | sed 's/^/     │ /'
  case "$VF_RC" in
    0) sentinela_presente ;;
    1) sentinela_ausente ;;
    *) echo "  ⚠️ ATRASADO? a sentinela não deu veredito — nem presente nem ausente"
       echo "     motivo: SENTINELA_SEM_VEREDITO — verify-frontend.sh saiu $VF_RC (2 = sonda não confiável · 3 = recusa); exit 3 para o alarme não calar, NÃO porque falte Publish"
       exit 3 ;;
  esac
fi
# Sem carimbo nem sentinela: exit 4 nos TRÊS estados do deploy-novo, por um helper só — o entry
# IGUAL não é "nada a relatar" (era, até 2026-09-14: ver o 4 no cabeçalho).
indeterminada() { # MARCA mensagem
  echo "  ⚠️ VERSAO_INDETERMINADA ($1): $2"
  echo "     sem carimbo, só o CONTEÚDO prova a versão: passe uma sentinela, ou descubra por que o ar não carimba SHA"
  exit 4
}
case "$DEPLOY" in
  nao*) indeterminada ENTRY_IGUAL "sem carimbo de SHA nem sentinela, e nada mudou desde a última checagem DESTE checkout — entry igual não diz se o ar == main" ;;
  "?"*) indeterminada PRIMEIRA_CHECAGEM "1a checagem deste checkout, sem carimbo de SHA nem sentinela" ;;
  *)    indeterminada ENTRY_NOVO "deploy novo detectado, mas sem carimbo de SHA nem sentinela → não dá pra confirmar a versão" ;;
esac
