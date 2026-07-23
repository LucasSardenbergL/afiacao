#!/usr/bin/env bash
# test-verify-edge-pat.sh — TDD da resolução do SUPABASE_PAT no verify-edge.sh (curl STUBADO).
#
# Regra: fonte do PAT em ordem — env SUPABASE_PAT > arquivo (LDV_PAT_FILE, default
#        ~/.config/afiacao/supabase-pat). Com PAT resolvido → o script consulta a Management
#        API (N2) com "Bearer <valor LIMPO>" (sem newline/espaço do arquivo). Sem nenhum →
#        não chama a API e imprime o handoff de N1.
#
# Uso: bash scripts/test-verify-edge-pat.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$here/../.claude/skills/lovable-deploy-verify/scripts/verify-edge.sh"

stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT

# stub de curl: registra os args; responde "200" pro OPTIONS (N1) e metadata pra Management API
cat >"$stub/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *api.supabase.com*) printf '%s' '{"version":7,"updated_at":"2026-07-23T12:00:00Z"}' ;;
  *) printf '%s' "200" ;;
esac
STUB
chmod +x "$stub/curl"
export PATH="$stub:$PATH"

fail=0
run() {  # run <envs...> — roda o script p/ a função fake e devolve stdout
  env CURL_LOG="$CURL_LOG" "$@" bash "$SCRIPT" edge-fake 2>/dev/null
}

echo "── PAT via ARQUIVO (env ausente) → N2 com Bearer limpo ──"
CURL_LOG="$stub/log1"; : > "$CURL_LOG"
printf '  sbp_segredo_do_arquivo  \n' > "$stub/pat-file"
out="$(run LDV_PAT_FILE="$stub/pat-file" SUPABASE_PAT=)"
if grep -qF 'Bearer sbp_segredo_do_arquivo' "$CURL_LOG" \
   && ! grep -qF 'Bearer  ' "$CURL_LOG" \
   && printf '%s' "$out" | grep -qF 'N2'; then
  echo "  ok    arquivo vira Bearer limpo + N2 no output"
else
  echo "  FAIL  arquivo nao virou Bearer/N2 | log=$(cat "$CURL_LOG")"; fail=1
fi

echo "── ENV vence o arquivo ──"
CURL_LOG="$stub/log2"; : > "$CURL_LOG"
out="$(run LDV_PAT_FILE="$stub/pat-file" SUPABASE_PAT=sbp_do_env)"
if grep -qF 'Bearer sbp_do_env' "$CURL_LOG" && ! grep -qF 'sbp_segredo_do_arquivo' "$CURL_LOG"; then
  echo "  ok    env tem precedencia"
else
  echo "  FAIL  env nao venceu | log=$(cat "$CURL_LOG")"; fail=1
fi

echo "── sem env e sem arquivo → sem Management API + handoff N1 ──"
CURL_LOG="$stub/log3"; : > "$CURL_LOG"
out="$(run LDV_PAT_FILE="$stub/nao-existe" SUPABASE_PAT=)"
if ! grep -qF 'api.supabase.com' "$CURL_LOG" && printf '%s' "$out" | grep -qF 'N1'; then
  echo "  ok    sem PAT nao consulta API e explica o handoff"
else
  echo "  FAIL  comportamento sem PAT errado | log=$(cat "$CURL_LOG") out='$out'"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
