#!/usr/bin/env bash
# pr-watch.sh — vigia o DESFECHO de um PR sob auto-merge e sai quando decidir:
#   exit 0 = MERGEADO · 2 = fechado sem merge · 3 = CONFLITO (precisa rebase)
#   exit 4 = CI VERMELHO · 5 = timeout sem desfecho · 64 = uso/deps errados
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

deadline=$(( $(date +%s) + timeout_min * 60 ))
echo "vigiando PR #$pr (timeout ${timeout_min}min, poll ${intervalo}s)…"

while :; do
  if ! info="$(gh pr view "$pr" --json state,mergeStateStatus,statusCheckRollup,title,url 2>/dev/null)"; then
    echo "AVISO: gh pr view falhou (rede?); nova tentativa em ${intervalo}s" >&2
    [ "$(date +%s)" -ge "$deadline" ] && { echo "⏳ TIMEOUT: sem conseguir consultar o PR #$pr"; exit 5; }
    sleep "$intervalo"
    continue
  fi

  state="$(jq -r '.state' <<<"$info")"
  msstat="$(jq -r '.mergeStateStatus // ""' <<<"$info")"
  titulo="$(jq -r '.title' <<<"$info")"
  url="$(jq -r '.url' <<<"$info")"

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

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "⏳ TIMEOUT: PR #$pr ainda ${state}/${msstat:-?} após ${timeout_min}min — $url"
    exit 5
  fi
  sleep "$intervalo"
done
