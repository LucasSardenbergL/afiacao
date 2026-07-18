#!/usr/bin/env bash
# pr-watch.sh — vigia o DESFECHO de um PR sob auto-merge e sai quando decidir:
#   exit 0 = MERGEADO · 2 = fechado sem merge · 3 = CONFLITO (precisa rebase)
#   exit 4 = CI VERMELHO · 5 = CONSULTEI e o PR segue sem desfecho (timeout)
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
command -v gh >/dev/null 2>&1 || { echo "ERRO: gh CLI ausente" >&2; exit 64; }
command -v jq >/dev/null 2>&1 || { echo "ERRO: jq ausente" >&2; exit 64; }

# Cartada final antes de declarar DESCONHECIDO: a falha de consulta costuma ser
# transitória (Wi-Fi reassociando depois do sono, rate limit passando).
# Sobrescrevível por env — os testes usam "0 0 0" pra não esperar de verdade.
read -ra backoffs <<< "${PR_WATCH_BACKOFFS:-5 15 45}"

ultimo_estado=""   # preenchido só por consulta BEM-SUCEDIDA; "" = nunca soube
ultimo_url=""

consultar() {
  gh pr view "$pr" --json state,mergeStateStatus,statusCheckRollup,title,url 2>/dev/null
}

# Recebe o JSON de uma consulta. SAI do script se houver desfecho (0/2/3/4).
# Retorna 0 = consultei e não há desfecho ainda · 1 = JSON ilegível/vazio, que
# é "não consultei" disfarçado (gh vivo devolvendo lixo) e NÃO pode virar 5.
decidir() {
  local info="$1" state msstat titulo url falhas
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

  falhas="$(jq -r '[.statusCheckRollup[]? | select(((.conclusion // .state // "") | ascii_upcase) | test("FAILURE|ERROR")) | (.name // .context // "check")] | unique | join(", ")' <<<"$info")"
  if [ -n "$falhas" ]; then
    echo "❌ CI VERMELHO: PR #$pr — checks: $falhas — $url"
    exit 4
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
  echo "❓ DESCONHECIDO: não consegui consultar o PR #$pr (rede/rate-limit/máquina dormindo) — $tentativas tentativa(s) extras, última leitura: ${ultimo_estado:-nenhuma}. O desfecho NÃO foi observado e o PR PODE ter mergeado: confirme com \`gh pr view $pr\` antes de reportar."
  exit 6
}

deadline=$(( $(date +%s) + timeout_min * 60 ))
echo "vigiando PR #$pr (timeout ${timeout_min}min, poll ${intervalo}s)…"

while :; do
  if info="$(consultar)" && decidir "$info"; then
    [ "$(date +%s)" -ge "$deadline" ] && timeout_consultado
  else
    [ "$(date +%s)" -ge "$deadline" ] && cartada_final
    echo "AVISO: gh pr view falhou (rede/rate-limit?); nova tentativa em ${intervalo}s" >&2
  fi
  sleep "$intervalo"
done
