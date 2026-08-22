#!/usr/bin/env bash
# test-codex-async.sh — TDD do scripts/codex-async.sh com `codex` STUBADO (sem quota).
#
# Contrato testado: 0=parecer entregue · 64=uso errado · 69=binário ausente ·
# 75=cota esgotada (SEM retry) · 77=sem auth · retry só em transitório ·
# watchdog mata execução travada.
#
# Uso: bash scripts/test-codex-async.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ASYNC="$here/codex-async.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/codexhome_ok" "$tmp/codexhome_vazio"
: > "$tmp/codexhome_ok/auth.json"

# stub de codex: comportamento por CODEX_STUB_MODE; conta invocações em CODEX_STUB_COUNT
cat >"$tmp/bin/codex" <<'STUB'
#!/bin/sh
echo x >> "$CODEX_STUB_COUNT"
case "$CODEX_STUB_MODE" in
  ok)        echo "parecer: aprovado com ressalvas"; exit 0 ;;
  quota)     echo "You have reached your usage limit" >&2; exit 1 ;;
  modelo)    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-5.6-sol'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2; exit 1 ;;
  ratelimit) n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
             if [ "$n" -ge 2 ]; then echo "parecer pós-retry"; exit 0
             else echo "429 rate limit exceeded" >&2; exit 1; fi ;;
  trava)     sleep 30 ;;
  *)         echo "erro desconhecido" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/codex"

fail=0
# ambiente controlado: PATH mínimo com o stub; sem env keys; backoffs zerados
run() {
  local mode="$1"; shift
  : > "$tmp/count"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/codexhome_ok" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
    CODEX_ASYNC_BACKOFFS="0 0 0" bash "$ASYNC" "$@" </dev/null
}
invocacoes() { wc -l < "$tmp/count" | tr -d ' '; }

caso_exit() { # nome want_exit rc
  if [ "$3" -eq "$2" ]; then echo "  ok    exit $3 | $1"
  else echo "  FAIL  want exit $2, got $3 | $1"; fail=1; fi
}

echo "── caminho feliz ──"
out="$(run ok "pergunta qualquer" 2>/dev/null)"; rc=$?
caso_exit "parecer entregue → 0" 0 "$rc"
if printf '%s' "$out" | grep -q "parecer: aprovado"; then echo "  ok    stdout contém o parecer"
else echo "  FAIL  parecer ausente do stdout"; fail=1; fi

echo "── preflight ──"
run ok 2>/dev/null; caso_exit "prompt vazio → 64" 64 $?
env -i PATH="/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" bash "$ASYNC" "x" >/dev/null 2>&1
caso_exit "codex ausente do PATH → 69" 69 $?
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" CODEX_HOME="$tmp/codexhome_vazio" \
  CODEX_STUB_MODE=ok CODEX_STUB_COUNT="$tmp/count" bash "$ASYNC" "x" >/dev/null 2>&1
caso_exit "sem auth (nem env, nem auth.json) → 77" 77 $?

echo "── cota e retry ──"
run quota "x" >/dev/null 2>&1; rc=$?
caso_exit "cota esgotada → 75" 75 "$rc"
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    cota NÃO faz retry (1 invocação)"
else echo "  FAIL  cota fez retry ($(invocacoes) invocações)"; fail=1; fi

echo "── modelo recusado pela conta ──"
# 400 do servidor quando o modelo do config não vale para a conta (2026-08-22: os 10
# nomes testados foram recusados, então NÃO é erro de digitação do nome — é direito de
# acesso). Antes caía no CODEX_FALHOU genérico: rc=1 e um tail de stderr, sem dizer o
# que fazer. Confundir com cota manda para o Caminho B, que é esperar — e esperar não
# conserta config.
saida=$(run modelo "x" 2>&1); rc=$?
caso_exit "modelo recusado → 78 (EX_CONFIG), não 75 nem 1" 78 "$rc"
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    modelo recusado NÃO faz retry (1 invocação)"
else echo "  FAIL  modelo recusado fez retry ($(invocacoes) invocações)"; fail=1; fi
case "$saida" in
  *MODELO_NAO_ACEITO*) echo "  ok    diagnóstico próprio (MODELO_NAO_ACEITO)" ;;
  *) echo "  FAIL  sem diagnóstico próprio: $(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-90)"; fail=1 ;;
esac
case "$saida" in
  *"codex login"*|*config.toml*) echo "  ok    diz o que FAZER (login/config)" ;;
  *) echo "  FAIL  não instrui a ação"; fail=1 ;;
esac
case "$saida" in
  *Caminho\ B*) echo "  FAIL  mandou para o Caminho B (esperar não conserta config)"; fail=1 ;;
  *) echo "  ok    NÃO manda para o Caminho B" ;;
esac

out="$(run ratelimit "x" 2>/dev/null)"; rc=$?
caso_exit "rate limit transitório → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    exatamente 1 retry (2 invocações)"
else echo "  FAIL  invocações=$(invocacoes), esperava 2"; fail=1; fi

echo "── watchdog (execução travada) ──"
run trava -t 1 "x" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$rc" -ne 75 ]; then echo "  ok    exit $rc ≠ 0 (matou o processo travado)"
else echo "  FAIL  watchdog não matou (exit $rc)"; fail=1; fi
if [ "$(invocacoes)" -eq 3 ]; then echo "  ok    esgotou as 3 tentativas"
else echo "  FAIL  invocações=$(invocacoes), esperava 3"; fail=1; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
