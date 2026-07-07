#!/usr/bin/env bash
# codex-async.sh — transporte pro ritual Codex (2ª opinião) SEM segurar a sessão.
#
# Por quê (diagnóstico 2026-07, 240 sessões): ~350+ execuções de `codex exec`
# rodaram em FOREGROUND com esperas de até 23min — a sessão Claude parada e o
# founder virando o "botão de retomar". Este wrapper é pensado pra rodar via
# Bash com run_in_background:true — a sessão segue trabalhando e integra o
# parecer quando o processo termina (o harness re-invoca a sessão ao concluir).
#
# O RITUAL (consult/challenge/review, prompts, quando usar) continua o da skill
# /codex (gstack) + docs/agent/money-path.md — este script só troca o TRANSPORTE.
# ⚠️ NUNCA aponte o Codex pro supabase/schema-snapshot.sql (~36k linhas — trava;
#    ver money-path.md). Fatos de schema vão NO PRÓPRIO prompt, via psql-ro.
#
# Uso:
#   scripts/codex-async.sh [-m MODELO] [-r low|medium|high|xhigh] [-t SEGUNDOS] "PROMPT"
#   echo "PROMPT" | scripts/codex-async.sh -r xhigh -
# Defaults: -m gpt-5.5 · -r high · -t 1200 (20min hard-stop)
#
# Garantias:
#   - preflight (binário + auth) ANTES de gastar tempo/quota, com instrução clara;
#   - retry com backoff (20s/60s) só em transitório (rate limit/timeout/overload);
#   - cota esgotada NÃO é transitório → falha na hora instruindo o Caminho B;
#   - mktemp XXXXXX (sem colisão de tmp entre execuções paralelas);
#   - sandbox read-only (consulta nunca escreve no repo).
set -u

modelo="gpt-5.5"; reasoning="high"; timeout_s=1200
while getopts "m:r:t:" opt; do
  case "$opt" in
    m) modelo="$OPTARG" ;;
    r) reasoning="$OPTARG" ;;
    t) timeout_s="$OPTARG" ;;
    *) echo "uso: codex-async.sh [-m modelo] [-r reasoning] [-t seg] \"PROMPT\"" >&2; exit 64 ;;
  esac
done
shift $((OPTIND-1))

prompt="${1:-}"
if [ "$prompt" = "-" ] || [ -z "$prompt" ]; then prompt="$(cat)"; fi
[ -n "$prompt" ] || { echo "ERRO: prompt vazio" >&2; exit 64; }

# --- preflight (barato, ANTES de gastar contexto/quota) -----------------------
command -v codex >/dev/null 2>&1 || {
  echo "PREFLIGHT_FAIL: codex CLI não encontrado. Instale: npm install -g @openai/codex" >&2
  exit 69
}
if [ -z "${CODEX_API_KEY:-}${OPENAI_API_KEY:-}" ] && [ ! -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
  echo "PREFLIGHT_FAIL: sem auth do Codex. Rode 'codex login' (ou exporte CODEX_API_KEY/OPENAI_API_KEY) e re-rode." >&2
  exit 77
fi

out="$(mktemp -t codex-async.XXXXXX)" || exit 70
err="$(mktemp -t codex-async-err.XXXXXX)" || exit 70
trap 'rm -f "$err"' EXIT

rc=1
tentativa=0
for backoff in 0 20 60; do
  tentativa=$((tentativa+1))
  [ "$backoff" -gt 0 ] && { echo "retry em ${backoff}s (tentativa $tentativa)…" >&2; sleep "$backoff"; }

  # hard-stop próprio: codex às vezes trava com processo vivo (money-path.md)
  codex exec --model "$modelo" -c model_reasoning_effort="$reasoning" \
    --sandbox read-only "$prompt" >"$out" 2>"$err" &
  pid=$!
  ( sleep "$timeout_s" && kill "$pid" 2>/dev/null ) &
  watchdog=$!
  wait "$pid"; rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null

  if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
    echo "=== PARECER CODEX (modelo $modelo · reasoning $reasoning · tentativa $tentativa) ==="
    cat "$out"
    echo
    echo "(cópia em $out)"
    exit 0
  fi

  # cota esgotada = NÃO-transitório → Caminho B na hora (money-path.md)
  if grep -qiE 'usage limit|quota|plan limit' "$err"; then
    echo "COTA_ESGOTADA: janela rolante de 7d do ChatGPT Plus esgotou. Siga o Caminho B (validação adversária própria + registrar 'REVISÃO INDEPENDENTE PENDENTE') — docs/agent/money-path.md." >&2
    exit 75
  fi
  # transitório (rede/limite/kill do watchdog) → tenta de novo
  if grep -qiE 'rate.?limit|429|timed?.?out|overloaded|temporarily|connection|ECONN|ETIMEDOUT|5[0-9][0-9]' "$err" || [ "$rc" -ge 124 ]; then
    continue
  fi
  break  # erro não-transitório → não insiste
done

echo "CODEX_FALHOU (rc=$rc) após $tentativa tentativa(s). stderr:" >&2
tail -20 "$err" >&2
exit "$rc"
