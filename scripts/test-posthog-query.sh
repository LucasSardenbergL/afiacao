#!/usr/bin/env bash
# test-posthog-query.sh — TDD do scripts/posthog-query.sh com `curl` STUBADO (sem rede).
#
# Contrato testado: 0=respondeu · 64=uso errado · 65=HogQL inválido (400) ·
# 68=rede/HTTP inesperado · 69=dependência quebrada · 75=rate limit (429) ·
# 77=sem auth (key ausente/VAZIA/phc_/permissão frouxa/401/403).
#
# Os dois testes que justificam o arquivo existir:
#   - a key NÃO aparece em argv (senão vaza pra `ps` de qualquer processo do usuário);
#   - HogQL com aspas/quebra-de-linha chega ao servidor ÍNTEGRO (escape errado
#     devolveria número ERRADO em silêncio, que é fabricação de dado).
# Ambos terminam com FALSIFICAÇÃO: o sensor é sabotado e tem de ficar VERMELHO.
#
# Uso: bash scripts/test-posthog-query.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
SUT="$here/posthog-query.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

falhas=0
ok()    { printf '  ✅ %s\n' "$1"; }
falha() { printf '  ❌ %s\n' "$1"; falhas=$((falhas + 1)); }

# Confere exit code esperado. Uso: espera <code> <descrição> -- <cmd...>
espera() {
  local want="$1" desc="$2"; shift 3
  local out; out="$("$@" 2>&1)"; local got=$?
  if [ "$got" -eq "$want" ]; then ok "$desc (exit $got)"
  else falha "$desc — esperava exit $want, veio $got · saída: $(printf '%s' "$out" | head -c 160)"; fi
}

# --- stub de curl -----------------------------------------------------------
# Grava argv/config/payload em $tmp e devolve corpo+status conforme CURL_STUB_STATUS.
cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in --version) echo "curl 8.0.0 (stub)"; exit 0 ;; esac
printf '%s\n' "$@" > "$CURL_STUB_ARGV"
saida=""; cfg=""; payload=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) saida="$2"; shift ;;
    --config) cfg="$2"; shift ;;
    --data-binary) payload="${2#@}"; shift ;;
  esac
  shift
done
[ -n "$cfg" ] && cp "$cfg" "$CURL_STUB_CFG"
[ -n "$payload" ] && cp "$payload" "$CURL_STUB_PAYLOAD"
if [ "${CURL_STUB_STATUS}" = "REDE" ]; then echo "could not resolve host" >&2; exit 6; fi
cat >"$saida" <<'BODY'
{"columns":["n"],"results":[[42]],"types":[["n","Int64"]],"hogql":"SELECT count()","clickhouse":"SELECT ...","metadata":{"x":1}}
BODY
[ "$CURL_STUB_STATUS" != "200" ] && printf '{"detail":"erro sintetico do stub"}' >"$saida"
printf '%s' "$CURL_STUB_STATUS"
exit 0
STUB
chmod +x "$tmp/bin/curl"

export CURL_STUB_ARGV="$tmp/argv.txt" CURL_STUB_CFG="$tmp/cfg.txt" CURL_STUB_PAYLOAD="$tmp/payload.json"
export PATH="$tmp/bin:$PATH"
export POSTHOG_API_HOST="https://exemplo.invalido"
export POSTHOG_PROJECT_ID="1234"
export POSTHOG_PROJECT_ID_FILE="$tmp/sem-id"

# keys sintéticas — NÃO são credenciais, só casam o formato que o script exige
key_boa="$tmp/key-boa";    printf 'phx_TESTE_SINTETICA_0123456789\n' > "$key_boa";  chmod 600 "$key_boa"
key_vazia="$tmp/key-vazia"; : > "$key_vazia";                                        chmod 600 "$key_vazia"
key_phc="$tmp/key-phc";     printf 'phc_publica_de_ingestao\n' > "$key_phc";          chmod 600 "$key_phc"
key_frouxa="$tmp/key-frouxa"; printf 'phx_TESTE_SINTETICA_0123456789\n' > "$key_frouxa"; chmod 644 "$key_frouxa"

echo "== uso errado =="
export POSTHOG_RO_KEY_FILE="$key_boa" CURL_STUB_STATUS=200
espera 64 "sem query e sem stdin"       -- bash "$SUT" </dev/null
espera 64 "query só com espaço em branco" -- bash "$SUT" "   " </dev/null
espera 64 "flag desconhecida"           -- bash "$SUT" --inventada "SELECT 1" </dev/null

echo "== auth fail-closed =="
espera 77 "key AUSENTE"                 -- env POSTHOG_RO_KEY_FILE="$tmp/nao-existe" bash "$SUT" "SELECT 1" </dev/null
espera 77 "key VAZIA (0 bytes)"         -- env POSTHOG_RO_KEY_FILE="$key_vazia" bash "$SUT" "SELECT 1" </dev/null
espera 77 "key phc_ (ingestão, não consulta)" -- env POSTHOG_RO_KEY_FILE="$key_phc" bash "$SUT" "SELECT 1" </dev/null
espera 77 "key com permissão 644"       -- env POSTHOG_RO_KEY_FILE="$key_frouxa" bash "$SUT" "SELECT 1" </dev/null

echo "== códigos HTTP =="
espera 65 "HTTP 400 → HogQL inválido"   -- env CURL_STUB_STATUS=400 bash "$SUT" "SELECT xx" </dev/null
espera 77 "HTTP 401 → sem auth"         -- env CURL_STUB_STATUS=401 bash "$SUT" "SELECT 1" </dev/null
espera 77 "HTTP 403 → escopo faltando"  -- env CURL_STUB_STATUS=403 bash "$SUT" "SELECT 1" </dev/null
espera 75 "HTTP 429 → rate limit"       -- env CURL_STUB_STATUS=429 bash "$SUT" "SELECT 1" </dev/null
espera 68 "HTTP 500 → inesperado"       -- env CURL_STUB_STATUS=500 bash "$SUT" "SELECT 1" </dev/null
espera 68 "curl falha de rede"          -- env CURL_STUB_STATUS=REDE bash "$SUT" "SELECT 1" </dev/null

echo "== dependência quebrada (sonda positiva, não command -v) =="
mkdir -p "$tmp/bin-quebrado"
printf '#!/bin/sh\nexit 1\n' > "$tmp/bin-quebrado/curl"; chmod +x "$tmp/bin-quebrado/curl"
espera 69 "curl PRESENTE mas quebrado"  -- env PATH="$tmp/bin-quebrado:$PATH" bash "$SUT" "SELECT 1" </dev/null
# O exit 69 sozinho e AMBIGUO (curl e jq compartilham o codigo): exija a MARCA do ramo,
# senao o teste fica verde com a sonda ERRADA falhando primeiro — que foi o que aconteceu
# na primeira rodada desta suite, com a sonda de jq alimentada com JSON invalido.
msg_curl="$(PATH="$tmp/bin-quebrado:$PATH" bash "$SUT" "SELECT 1" 2>&1 </dev/null)"
case "$msg_curl" in
  *curl*) ok "exit 69 aponta CURL (nao o jq)" ;;
  *) falha "exit 69 veio de outro ramo: $(printf '%s' "$msg_curl" | head -c 120)" ;;
esac

# igual <recebido> <esperado> <descrição>
igual() { if [ "$1" = "$2" ]; then ok "$3"; else falha "$3 — esperava '$2', veio '$1'"; fi; }
# tem_campo <json> <campo> → 0 se o campo existe
tem_campo() { printf '%s' "$1" | jq -e --arg c "$2" 'has($c)' >/dev/null 2>&1; }

echo "== caminho feliz =="
saida="$(CURL_STUB_STATUS=200 bash "$SUT" "SELECT count() FROM events" 2>&1)"; rc=$?
igual "$rc" "0" "exit 0"
igual "$(printf '%s' "$saida" | jq -r '.row_count')" "1" "row_count calculado"
igual "$(printf '%s' "$saida" | jq -r '.results[0][0]')" "42" "results preservado"
if tem_campo "$saida" clickhouse; then falha "compacto deveria DESCARTAR clickhouse/metadata"
else ok "compacto descarta clickhouse/metadata"; fi
cru_out="$(CURL_STUB_STATUS=200 bash "$SUT" --cru "SELECT 1" 2>/dev/null)"
if tem_campo "$cru_out" clickhouse; then ok "--cru preserva o payload inteiro"
else falha "--cru deveria trazer clickhouse"; fi
saida_stdin="$(printf 'SELECT 1' | CURL_STUB_STATUS=200 bash "$SUT" 2>&1)"
igual "$(printf '%s' "$saida_stdin" | jq -r '.row_count')" "1" "HogQL via stdin"

echo "== a key NAO vaza pra argv (visivel em \`ps\`) =="
CURL_STUB_STATUS=200 bash "$SUT" "SELECT 1" >/dev/null 2>&1
if grep -q 'phx_' "$tmp/argv.txt"; then falha "key VAZOU em argv"; else ok "argv nao contem a key"; fi
if grep -q 'phx_' "$tmp/cfg.txt"; then ok "key foi pelo --config (arquivo)"; else falha "key nao chegou pelo --config"; fi
# FALSIFICACAO: um argv COM a key tem de ser pego — senao o teste acima e cego.
printf 'Authorization: Bearer phx_VAZAMENTO\n' > "$tmp/argv-sabotado.txt"
if grep -q 'phx_' "$tmp/argv-sabotado.txt"; then ok "falsificacao: o detector PEGA um vazamento real"
else falha "falsificacao: detector de vazamento e CEGO"; fi

echo "== HogQL chega INTEGRO (escape) =="
complexa="SELECT properties.\$current_url AS \"u\", count()
FROM events WHERE event = 'carteira.mixgap_visto' AND properties.estado != 'sem_rede'"
CURL_STUB_STATUS=200 bash "$SUT" "$complexa" >/dev/null 2>&1
recebida="$(jq -r '.query.query' "$tmp/payload.json")"
if [ "$recebida" = "$complexa" ]; then ok "aspas/quebra-de-linha/\$ preservados"
else falha "HogQL corrompido no transporte"; printf '    enviado:  %s\n    recebido: %s\n' "$complexa" "$recebida"; fi
igual "$(jq -r '.query.kind' "$tmp/payload.json")" "HogQLQuery" "kind=HogQLQuery"
# FALSIFICACAO: a comparacao tem de reprovar quando o texto REALMENTE difere.
if [ "$recebida" = "${complexa}X" ]; then falha "falsificacao: comparacao de HogQL e CEGA"
else ok "falsificacao: comparacao reprova texto diferente"; fi

echo
if [ "$falhas" -eq 0 ]; then echo "✅ test-posthog-query.sh: tudo verde"; exit 0
else echo "❌ test-posthog-query.sh: $falhas falha(s)"; exit 1; fi
