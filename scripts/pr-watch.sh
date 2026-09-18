#!/usr/bin/env bash
# pr-watch.sh — vigia o DESFECHO de um PR sob auto-merge e sai quando decidir:
#   exit 0 = MERGEADO · 2 = fechado sem merge · 3 = CONFLITO (precisa rebase)
#   exit 4 = check OBRIGATÓRIO vermelho, ou SEM VEREDITO (`cancelled`/`timed_out`)
#            — a mensagem distingue; ver `julgar_checks`. Vermelho FORA dos
#            obrigatórios (ex.: `mutation-check`) NÃO é desfecho: sai na saída
#            como `AVISO NAO-OBRIGATORIO [<checks>]` e a vigília segue
#   exit 5 = CONSULTEI e o PR segue sem desfecho (timeout)
#   exit 6 = NÃO CONSEGUI CONSULTAR — estado DESCONHECIDO: confirme com
#            `gh pr view <nº>` ANTES de reportar qualquer coisa ao founder
#   exit 64 = uso/deps errados
#
# 5 e 6 eram o MESMO código até o #1396 (2026-07-17): o watcher não conseguiu
# consultar, saiu 5, e o PR tinha MERGEADO normalmente — o falso negativo
# exatamente do tipo que este script existe pra evitar. Pista de que era 6 e
# não 5: pouquíssimos AVISOs antes do fim (2, não ~45). A máquina dormiu, o
# relógio saltou o deadline, e o script desistiu após 2 tentativas reais em vez
# de 45min de rede fora — por isso a cartada final abaixo, com backoff.
#
# O 4 saía para QUALQUER check vermelho até 2026-09-14 — o falso POSITIVO gêmeo
# daquele falso negativo. No #2472 o `mutation-check`, que não é obrigatório (o
# auto-merge só espera o `validate`), fez este vigia dizer "CI VERMELHO" três
# vezes, a última enquanto o PR MERGEAVA. Alarme que mente morre do mesmo jeito
# que alarme mudo: a sessão aprende a reconsultar à mão e a ignorar o 4.
# Ver docs/historico/vigia-vermelho-nao-obrigatorio.md.
#
# A JANELA CONTA VIGÍLIA, não relógio de parede (ver `dormir`): no suspend o
# `sleep` não avança mas o `date` sim, então o tempo dormido é devolvido ao
# deadline. Um watcher pode viver bem mais que os N min nominais — intencional:
# cada wake compra um poll, e é esse poll que encontra o desfecho.
#
# Por quê (diagnóstico 2026-07): o founder virou o poller do auto-merge ("por
# que o #868 não mergeou?", PR órfão descoberto dias depois). Rode via Bash com
# run_in_background:true logo após criar/atualizar o PR: quando este processo
# sai, o harness re-invoca a sessão, que avisa o founder via PushNotification
# (mergeado/conflito/CI vermelho) — CLAUDE.md §Merge.
#
# Uso: scripts/pr-watch.sh <numero-PR> [timeout-min=45] [intervalo-s=60]
set -u

pr="${1:?uso: pr-watch.sh <numero-PR> [timeout-min] [intervalo-s]}"
timeout_min="${2:-45}"
intervalo="${3:-60}"
# NÚMERO, não URL/branch: a consulta dos obrigatórios é `isRequired(pullRequestNumber:)`, Int!.
# O `gh pr view` aceitaria os dois — e o erro só apareceria no primeiro vermelho, como 6.
case "$pr" in
  *[!0-9]*) echo "ERRO: <numero-PR> tem de ser o número do PR (veio: $pr)" >&2; exit 64 ;;
esac
command -v gh >/dev/null 2>&1 || { echo "ERRO: gh CLI ausente" >&2; exit 64; }
command -v jq >/dev/null 2>&1 || { echo "ERRO: jq ausente" >&2; exit 64; }

# Cartada final antes de declarar DESCONHECIDO: a falha de consulta costuma ser
# transitória (Wi-Fi reassociando depois do sono, rate limit passando).
# Sobrescrevível por env — os testes usam "0 0 0" pra não esperar de verdade.
read -ra backoffs <<< "${PR_WATCH_BACKOFFS:-5 15 45}"

# Tolerância do detector de salto: `sleep N` estoura o esperado por 0–1s
# (quantização do `date +%s` + scheduler); suspend estoura por MINUTOS.
tolerancia_salto="${PR_WATCH_TOLERANCIA_SALTO:-5}"

ultimo_estado=""   # preenchido só por consulta BEM-SUCEDIDA; "" = nunca soube
ultimo_url=""
ultimo_aviso=""    # checks não-obrigatórios do último AVISO — repetir a cada poll é ruído
ultimo_superado="" # idem para o aviso de vermelho SUPERADO por run mais novo

# Critério ÚNICO de alarme, servido às duas consultas: o `gh pr view` e o GraphQL dizem
# `conclusion` no CheckRun e `state` no StatusContext.
JQ_CHECKS='def rotulo: (.conclusion // .state // "") | ascii_upcase;
def vermelho: rotulo | test("FAILURE|ERROR");
def sem_veredito: rotulo | test("^(CANCELLED|CANCELED|TIMED_OUT|STALE)$");
def nome: .name // .context // "check";
# Varios check runs com o MESMO nome no mesmo commit: re-run, ou run que a concurrency cancelou e
# outro evento do mesmo PR refez (medido no #2507: um CANCELLED e dois SUCCESS no mesmo head). Vale o
# mais RECENTE, e o superado nao e desfecho. Sem carimbo em algum deles nao da para ordenar, e
# ausente != zero: ai contam TODOS, que e o lado fail-closed.
def quando: (.startedAt // .createdAt // "");
def ultimos: group_by(nome) | map(if any(.[]; quando == "") then .[] else max_by(quando) end);'

consultar() {
  gh pr view "$pr" --json state,mergeStateStatus,statusCheckRollup,title,url 2>/dev/null
}

# Quais checks do head são OBRIGATÓRIOS para ESTE PR — é o que decide o 4. `isRequired` é o
# GitHub avaliando a proteção da branch (e rulesets) contra cada check, pelo mesmo critério que
# segura o auto-merge; o `gh pr view` não expõe o campo.
#
# Não `gh pr checks --required`: o `validate` é agregador e só NASCE depois dos `needs` (no
# #2472, check-run criado às 14:09:39Z, 3s após o último need), e nessa janela o `--required`
# sai com ERRO ("no required checks reported") — indistinguível de rede fora sem ler o texto do
# stderr. Aqui "nenhum obrigatório reportado ainda" é lista sem `isRequired: true`, e erro é rc≠0.
# shellcheck disable=SC2016  # `$owner`/`$name`/`$pr` na query são variáveis do GraphQL, não do shell
consultar_obrigatorios() {
  gh api graphql -F owner='{owner}' -F name='{repo}' -F pr="$pr" -f query='
    query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              ... on CheckRun { name conclusion startedAt isRequired(pullRequestNumber: $pr) }
              ... on StatusContext { context state createdAt isRequired(pullRequestNumber: $pr) }
            }
          } } } } }
        }
      }
    }' 2>/dev/null
}

# Chamada só quando o rollup tem check vermelho/sem veredito; decide se isso é DESFECHO.
#   obrigatório vermelho → exit 4 · obrigatório sem veredito → exit 4 (mensagem própria)
#   não-obrigatório      → AVISO NAO-OBRIGATORIO (uma vez por conjunto) e segue: return 0
#   return 1 = NÃO consegui classificar: consulta com rc≠0 (inclusive a resposta PARCIAL do
#   GraphQL, que chega com corpo legível, `errors` e rc=1), resposta ilegível ou truncada, ou
#   check com alarme sem `isRequired` booleano. "Não sei se é obrigatório" nunca vira "não é".
julgar_checks() {
  local url="$1" resp nos classes req_vermelhos="" req_sem_veredito="" nao_obrigatorios="" superados=""
  if ! resp="$(consultar_obrigatorios)"; then
    echo "AVISO: consulta dos checks OBRIGATÓRIOS falhou (rede/rate-limit?)" >&2
    return 1
  fi
  # Truncada é ilegível: com `hasNextPage` o obrigatório vermelho pode estar na página 2.
  nos="$(jq -c '.data.repository.pullRequest.commits.nodes[-1].commit.statusCheckRollup.contexts
    | select(.pageInfo.hasNextPage == false) | .nodes | select(type == "array")' <<<"$resp" 2>/dev/null)"
  if [ -z "$nos" ]; then
    echo "AVISO: resposta dos checks OBRIGATÓRIOS ilegível ou truncada (>100 checks?)" >&2
    return 1
  fi
  # 3 linhas: obrigatórios vermelhos · obrigatórios sem veredito · não-obrigatórios com alarme
  if ! classes="$(jq -r "$JQ_CHECKS"'
      ultimos as $vigentes
      | [$vigentes[] | select(vermelho or sem_veredito)] as $alarmes
      | [(. - $vigentes)[] | select(vermelho or sem_veredito) | nome] as $superados
      | if any($alarmes[]; (.isRequired | type) != "boolean") then error("isRequired ausente")
        else ([$alarmes[] | select(.isRequired and vermelho) | nome] | unique | join(", ")),
             ([$alarmes[] | select(.isRequired and (vermelho | not)) | nome] | unique | join(", ")),
             ([$alarmes[] | select(.isRequired | not) | nome] | unique | join(", ")),
             ($superados | unique | join(", "))
        end' <<<"$nos" 2>/dev/null)"; then
    echo "AVISO: check vermelho sem \`isRequired\` na resposta — não sei se é obrigatório" >&2
    return 1
  fi
  { IFS= read -r req_vermelhos; IFS= read -r req_sem_veredito; IFS= read -r nao_obrigatorios; IFS= read -r superados; } <<<"$classes"

  if [ -n "$nao_obrigatorios" ] && [ "$nao_obrigatorios" != "$ultimo_aviso" ]; then
    echo "⚠️ AVISO NAO-OBRIGATORIO [$nao_obrigatorios]: PR #$pr — vermelho/sem veredito FORA dos checks obrigatórios; não segura o auto-merge, sigo vigiando — $url"
  fi
  ultimo_aviso="$nao_obrigatorios"

  # Vermelho que outro run mais novo do mesmo nome já superou: some do veredito, mas não do log —
  # calar seria esconder que houve vermelho no head.
  if [ -n "$superados" ] && [ "$superados" != "$ultimo_superado" ]; then
    echo "ℹ️ SUPERADO [$superados]: PR #$pr — vermelho/sem veredito de run mais VELHO do mesmo nome, superado por outro mais novo; não é desfecho — $url"
  fi
  ultimo_superado="$superados"

  if [ -n "$req_vermelhos" ]; then
    echo "❌ CI VERMELHO [$req_vermelhos]: PR #$pr — check obrigatório reprovado — $url"
    exit 4
  fi

  # Check obrigatório que terminou SEM VEREDITO — `CANCELLED` (estouro de `timeout-minutes`, ou
  # cancelamento manual) e `TIMED_OUT`/`STALE`. Não casava a regex do vermelho até 2026-09-07, e
  # a consequência era silêncio de 45 min: o check nunca vira verde, nunca casa FAILURE, e o
  # watcher ia até o timeout sair **5** ("segue sem desfecho") — o mesmo falso negativo que o
  # exit 6 veio separar do 5, só que pelo outro lado. Não é hipótese: naquele dia o job
  # `validate` rodava a segundos do teto de 15 min e 5 de 69 runs saíram `cancelled`.
  #
  # Sai 4 junto com o vermelho de propósito: o desfecho ACIONÁVEL é idêntico (o auto-merge não
  # vai acontecer e o PR precisa de humano), e um código novo quebraria quem já trata 0-6. Mas a
  # MENSAGEM é outra — mandar o founder caçar um defeito de teste que não existe custa a mesma
  # sessão que o silêncio custava. Ver docs/historico/ci-validate-timeout-15min.md.
  if [ -n "$req_sem_veredito" ]; then
    echo "⚠️ CI SEM VEREDITO [$req_sem_veredito] (não é reprovação de teste): PR #$pr — $url"
    echo "   cancelled = estouro de \`timeout-minutes\` ou cancelamento; o CI não afirmou nada."
    echo "   Meça antes de re-rodar: gh run view <id> --json jobs (quantos steps executaram?)."
    exit 4
  fi
  return 0
}

# Recebe o JSON de uma consulta. SAI do script se houver desfecho (0/2/3/4).
# Retorna 0 = consultei e não há desfecho ainda · 1 = JSON ilegível/vazio, que
# é "não consultei" disfarçado (gh vivo devolvendo lixo) e NÃO pode virar 5.
decidir() {
  local info="$1" state msstat titulo url alarme
  # NB: `local x="$(cmd)"` mascara o rc do cmd — por isso declarar e atribuir
  # em linhas separadas.
  state="$(jq -r '.state // empty' <<<"$info" 2>/dev/null)" || return 1
  [ -n "$state" ] || return 1
  msstat="$(jq -r '.mergeStateStatus // ""' <<<"$info")"
  titulo="$(jq -r '.title // "?"' <<<"$info")"
  url="$(jq -r '.url // "?"' <<<"$info")"

  case "$state" in
    MERGED) echo "✅ MERGEADO: PR #$pr — $titulo — $url"; exit 0 ;;
    CLOSED) echo "⚠️ FECHADO SEM MERGE: PR #$pr — $titulo — $url"; exit 2 ;;
  esac

  if [ "$msstat" = "DIRTY" ]; then
    echo "❌ CONFLITO: PR #$pr precisa de rebase — $titulo — $url"
    exit 3
  fi

  # Vermelho no rollup é só o GATILHO da 2ª consulta; quem decide o desfecho é o subconjunto
  # obrigatório (`julgar_checks`). Sem alarme não há o que perguntar.
  # DE PROPÓSITO sem `ultimos` aqui: este é o GATILHO, não o veredito. Um vermelho já superado por
  # run mais novo do mesmo nome ainda precisa chamar o classificador — é lá que ele vira a nota
  # SUPERADO. Filtrar aqui calaria a nota (medido: a suíte fica verde e o log emudece).
  alarme="$(jq -r "$JQ_CHECKS"' any(.statusCheckRollup[]?; vermelho or sem_veredito)' <<<"$info" 2>/dev/null)" || return 1
  if [ "$alarme" = true ]; then
    julgar_checks "$url" || return 1
  else
    ultimo_aviso=""
  fi

  ultimo_estado="${state}/${msstat:-?}"
  ultimo_url="$url"
  return 0
}

# Só quem CONSULTOU pode sair 5.
timeout_consultado() {
  echo "⏳ TIMEOUT: PR #$pr ainda ${ultimo_estado} após ${timeout_min}min — $ultimo_url"
  exit 5
}

# Deadline bateu sem consulta boa: insiste mais algumas vezes antes de desistir,
# porque a falha costuma ser transitória — e um desfecho real encontrado aqui
# vence o timeout (foi o que faltou no #1396).
cartada_final() {
  local backoff tentativas=0
  echo "AVISO: consulta falhando no fim da janela; última cartada (backoff ${backoffs[*]}s)…" >&2
  for backoff in "${backoffs[@]}"; do
    tentativas=$((tentativas + 1))
    [ "$backoff" -gt 0 ] && sleep "$backoff"
    if info="$(consultar)" && decidir "$info"; then
      timeout_consultado   # consegui consultar: o PR realmente segue sem desfecho
    fi
  done
  echo "❓ DESCONHECIDO: não consegui consultar o PR #$pr (rede/rate-limit/máquina dormindo, ou checks obrigatórios ilegíveis) — $tentativas tentativa(s) extras, última leitura: ${ultimo_estado:-nenhuma}. O desfecho NÃO foi observado e o PR PODE ter mergeado: confirme com \`gh pr view $pr\` antes de reportar."
  exit 6
}

# Dorme o intervalo e DEVOLVE ao deadline o tempo em que a máquina esteve
# suspensa. A janela conta tempo VIGIANDO, não relógio de parede: durante o
# suspend o `sleep` não avança mas o `date` sim, então sem isso um laptop
# fechado queima os 45min tendo consultado 2× (o gatilho do #1396).
# Sem teto de extensão de propósito: cada wake compra ao menos 1 poll, e esse
# poll quase sempre já resolve o PR — além de o watcher morrer com a sessão.
dormir() {
  local antes depois excesso
  antes="$(date +%s)"
  sleep "$intervalo"
  depois="$(date +%s)"
  excesso=$(( depois - antes - intervalo ))
  if [ "$excesso" -gt "$tolerancia_salto" ]; then
    deadline=$(( deadline + excesso ))
    echo "AVISO: o relógio saltou ${excesso}s neste poll (máquina dormiu?) — a janela conta vigília, então foi estendida" >&2
  fi
}

deadline=$(( $(date +%s) + timeout_min * 60 ))
echo "vigiando PR #$pr (timeout ${timeout_min}min, poll ${intervalo}s)…"

while :; do
  if info="$(consultar)" && decidir "$info"; then
    [ "$(date +%s)" -ge "$deadline" ] && timeout_consultado
  else
    [ "$(date +%s)" -ge "$deadline" ] && cartada_final
    echo "AVISO: consulta ao GitHub falhou ou veio ilegível (rede/rate-limit?); nova tentativa em ${intervalo}s" >&2
  fi
  dormir
done
