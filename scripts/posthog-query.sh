#!/usr/bin/env bash
# posthog-query.sh — HogQL READ-ONLY contra o PostHog de PRODUÇÃO do Afiação.
#
# Existe porque o repo instalava sensores de frontend (`carteira.mixgap_visto`,
# `carteira.positivacao_vista`, `dashboard.*`, `offline.*`) que NINGUÉM conseguia
# ler: em 2026-08-22 (PR #1900) as quatro vias de acesso foram medidas e as quatro
# estavam fechadas — plugin desabilitado, nenhuma Personal API Key, navegador sem
# sessão, nenhum espelho no banco. Sem esta via, a regra de
# docs/historico/fase-sem-sinal.md ("fase N+1 exige ≥1 sinal POSITIVO de uso em
# prod, COM denominador; 'quando medir' é query, não recado") era incumprível
# para todo sensor de frontend — o repo instalava sensor cego por construção.
#
# A key é Personal API Key de escopo SÓ-LEITURA (query:read/insight:read/
# event:read), 0600 FORA do repo — mesmo padrão do ~/.config/afiacao/claude_ro.pgpass.
# Ela nunca entra em argv: vai por `curl --config`, senão apareceria em `ps`.
# O read-only real é o ESCOPO no servidor; o script só nunca constrói outra URL
# que não `/query/` (HogQL não tem DML), então não há blocklist de texto — que
# seria teatro.
#
# Uso:
#   scripts/posthog-query.sh "SELECT count() FROM events WHERE ..."
#   echo "SELECT ..." | scripts/posthog-query.sh
#   scripts/posthog-query.sh --cru "SELECT ..."    # payload inteiro do PostHog
#   scripts/posthog-query.sh --cache "SELECT ..."  # aceita cache (rapido, pode MENTIR)
#
# Saída (default): {"columns":[…],"results":[…],"row_count":N} — compacto de
# PROPÓSITO: o payload cru traz clickhouse/hogql/explain/metadata e queima
# contexto de sessão de agente sem acrescentar dado. `--cru` quando precisar do
# SQL gerado pra depurar.
#
# Exit: 0=respondeu · 64=uso errado · 65=HogQL inválido (HTTP 400) ·
#       73=query estourou o tempo (HTTP 504) — ausência de dado, NÃO zero ·
#       68=rede/HTTP inesperado · 69=dependência ausente/quebrada ·
#       75=rate limit (HTTP 429) · 77=sem auth (key ruim, ou HTTP 401/403)
#
# Sondas são FAIL-CLOSED e exigem resposta POSITIVA: `command -v` não basta
# (binário presente-porém-quebrado passaria), e arquivo de key VAZIO é o modo de
# falha já observado neste repo — ~/.config/afiacao/supabase-pat existe com
# 0 bytes desde 2026-07-27.
set -u

KEYFILE="${POSTHOG_RO_KEY_FILE:-$HOME/.config/afiacao/posthog-ro}"
IDFILE="${POSTHOG_PROJECT_ID_FILE:-$HOME/.config/afiacao/posthog-project-id}"
HOST="${POSTHOG_API_HOST:-https://us.posthog.com}"

cru=0
query=""
# `force_blocking` RECALCULA sempre. O default do PostHog serve do CACHE quando a
# query e' BYTE-A-BYTE identica a uma anterior — e devolve o resultado velho SEM
# marcar que e' velho. Em 2026-08-24 isso custou horas: `SELECT count(), max(ts)
# FROM events` repetida ao longo do dia congelou em 2.630/23-08 enquanto o valor
# real ja era 2.631/24-08, e a conclusao "a ingestao aceita e DESCARTA" nasceu
# dai. Medicao paga o recalculo; quem quiser velocidade pede --cache.
refresh="force_blocking"
while [ $# -gt 0 ]; do
  case "$1" in
    --cru) cru=1 ;;
    --cache) refresh="force_cache" ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "❌ flag desconhecida: $1 (só existem --cru e --help)" >&2; exit 64 ;;
    *) query="$1" ;;
  esac
  shift
done

# stdin só quando não veio argumento E não é terminal — senão o script pendura
# esperando digitação, que numa sessão de agente vira timeout sem diagnóstico.
if [ -z "$query" ] && [ ! -t 0 ]; then query="$(cat)"; fi
if [ -z "${query//[[:space:]]/}" ]; then
  echo "❌ uso: $0 \"<HogQL>\"   (ou HogQL no stdin)" >&2
  exit 64
fi

# --- sondas positivas -------------------------------------------------------
curl --version >/dev/null 2>&1 || {
  echo "❌ curl ausente ou quebrado (não respondeu a --version)" >&2; exit 69; }

# jq é OBRIGATÓRIO pra MONTAR o corpo: escapar HogQL (aspas, quebra de linha,
# barra) à mão em bash erra em silêncio, e query mal-escapada devolve resultado
# ERRADO em vez de falhar — fabricação de número, que é o pecado do money-path.
# Na LEITURA da resposta ele é opcional (degradar pra JSON cru só perde compactação).
[ "$(jq -rn '"ok"' 2>/dev/null)" = "ok" ] || {
  echo "❌ jq ausente ou quebrado — necessário pra escapar o HogQL com segurança" >&2
  echo "   → brew install jq" >&2; exit 69; }

[ -f "$KEYFILE" ] || {
  echo "❌ key do PostHog ausente: $KEYFILE" >&2
  echo "   → veja docs/agent/analytics.md (§ instalar a key)" >&2; exit 77; }
[ -s "$KEYFILE" ] || {
  echo "❌ key do PostHog VAZIA (0 bytes): $KEYFILE" >&2
  echo "   → arquivo criado mas nunca preenchido; veja docs/agent/analytics.md" >&2; exit 77; }

perm="$(stat -f '%Lp' "$KEYFILE" 2>/dev/null)" || perm="$(stat -c '%a' "$KEYFILE" 2>/dev/null)"
case "$perm" in
  *00) : ;;
  "") echo "⚠️  não consegui ler a permissão de $KEYFILE — seguindo" >&2 ;;
  *) echo "❌ $KEYFILE tem permissão $perm — segredo legível por outros" >&2
     echo "   → chmod 600 $KEYFILE" >&2; exit 77 ;;
esac

key="$(tr -d ' \t\r\n' < "$KEYFILE")"
case "$key" in
  phx_*) : ;;
  phc_*) echo "❌ isso é a chave PÚBLICA de INGESTÃO (phc_), que escreve evento e não consulta." >&2
         echo "   → precisa de uma Personal API Key (phx_); veja docs/agent/analytics.md" >&2; exit 77 ;;
  *) echo "❌ key em $KEYFILE não parece Personal API Key (esperado prefixo phx_)" >&2; exit 77 ;;
esac

projeto="${POSTHOG_PROJECT_ID:-}"
if [ -z "$projeto" ] && [ -s "$IDFILE" ]; then projeto="$(tr -d ' \t\r\n' < "$IDFILE")"; fi
projeto="${projeto:-@current}"

# --- requisição -------------------------------------------------------------
umask 077
tmp="$(mktemp -d)" || { echo "❌ mktemp falhou" >&2; exit 68; }
trap 'rm -rf "$tmp"' EXIT

jq -n --arg q "$query" --arg r "$refresh" '{query: {kind: "HogQLQuery", query: $q}, refresh: $r}' > "$tmp/payload.json" || {
  echo "❌ jq falhou ao montar o corpo da requisição" >&2; exit 68; }

# A key vai pelo --config e NÃO por -H: argv é visível em `ps` pra qualquer
# processo do usuário. O arquivo nasce sob umask 077 e morre no trap.
printf 'header = "Authorization: Bearer %s"\n' "$key" > "$tmp/curl.cfg"

status="$(curl --config "$tmp/curl.cfg" \
  -sS --max-time 120 \
  -H 'Content-Type: application/json' \
  -X POST "$HOST/api/projects/$projeto/query/" \
  --data-binary "@$tmp/payload.json" \
  -o "$tmp/body.json" -w '%{http_code}' 2>"$tmp/curl.err")"
rc=$?

if [ "$rc" -ne 0 ]; then
  echo "❌ curl falhou (exit $rc) contra $HOST" >&2
  head -c 500 "$tmp/curl.err" >&2; echo >&2
  exit 68
fi

case "$status" in
  200) : ;;
  400) echo "❌ HTTP 400 — HogQL inválido:" >&2
       jq -r '.detail // .error // .' "$tmp/body.json" 2>/dev/null | head -c 800 >&2 || head -c 800 "$tmp/body.json" >&2
       echo >&2; exit 65 ;;
  401|403) echo "❌ HTTP $status — key rejeitada ou sem o escopo necessário (query:read)." >&2
       jq -r '.detail // .' "$tmp/body.json" 2>/dev/null | head -c 500 >&2
       echo >&2
       [ "$projeto" = "@current" ] && echo "   → se a key é ESCOPADA a um projeto, @current pode não resolver: grave o id numérico em $IDFILE" >&2
       exit 77 ;;
  429) echo "❌ HTTP 429 — rate limit do PostHog. Espere e repita." >&2; exit 75 ;;
  504) echo "❌ HTTP 504 — a query estourou o tempo de execucao do PostHog." >&2
       echo "   Isto e' AUSENCIA DE DADO, nao zero: nada foi medido." >&2
       echo "   → estreite a janela/colunas, ou use --cache se um valor recente servir." >&2
       exit 73 ;;
  *) echo "❌ HTTP $status inesperado de $HOST" >&2
     head -c 800 "$tmp/body.json" >&2; echo >&2; exit 68 ;;
esac

if [ "$cru" -eq 1 ]; then
  cat "$tmp/body.json"
else
  jq -c '{columns: .columns, results: .results, row_count: (.results | length)}' "$tmp/body.json" \
    || { echo "⚠️  jq falhou ao compactar — devolvendo payload cru" >&2; cat "$tmp/body.json"; }
fi
