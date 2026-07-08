#!/usr/bin/env bash
# test-pr-watch.sh — TDD do scripts/pr-watch.sh com `gh` STUBADO (sem rede).
#
# Contrato testado (exit codes): 0=MERGED · 2=CLOSED · 3=DIRTY(conflito) ·
# 4=CI vermelho · 5=timeout sem desfecho (inclusive gh falhando sempre).
#
# Uso: bash scripts/test-pr-watch.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
WATCH="$here/pr-watch.sh"

stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT

# stub de gh: devolve o JSON do cenário (GH_STUB_FILE) ou falha (GH_STUB_EXIT)
cat >"$stub/gh" <<'STUB'
#!/bin/sh
[ -n "${GH_STUB_EXIT:-}" ] && exit "$GH_STUB_EXIT"
cat "$GH_STUB_FILE"
STUB
chmod +x "$stub/gh"
export PATH="$stub:$PATH"

fail=0

# roda o watcher com timeout curtíssimo (0 min) e poll de 1s
caso() {
  local nome="$1" want_exit="$2" json="$3" out rc
  printf '%s' "$json" > "$stub/cenario.json"
  out="$(GH_STUB_FILE="$stub/cenario.json" bash "$WATCH" 999 0 1 2>/dev/null)"; rc=$?
  if [ "$rc" -eq "$want_exit" ]; then
    echo "  ok    exit $rc | $nome"
  else
    echo "  FAIL  want exit $want_exit, got $rc | $nome | $out"; fail=1
  fi
}

echo "── desfechos terminais ──"
caso "MERGED → 0" 0 '{"state":"MERGED","mergeStateStatus":"CLEAN","statusCheckRollup":[],"title":"t","url":"u"}'
caso "CLOSED sem merge → 2" 2 '{"state":"CLOSED","mergeStateStatus":"","statusCheckRollup":[],"title":"t","url":"u"}'
caso "conflito (DIRTY) → 3" 3 '{"state":"OPEN","mergeStateStatus":"DIRTY","statusCheckRollup":[],"title":"t","url":"u"}'
caso "CI vermelho (conclusion FAILURE) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"FAILURE"}],"title":"t","url":"u"}'
caso "CI vermelho (state ERROR, sem conclusion) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"context":"ci","state":"error"}],"title":"t","url":"u"}'

echo "── sem desfecho ──"
caso "OPEN limpo até o deadline → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":null}],"title":"t","url":"u"}'

# gh falhando sempre (rede fora) → timeout 5, nunca trava
out="$(GH_STUB_EXIT=1 GH_STUB_FILE=/dev/null bash "$WATCH" 999 0 1 2>/dev/null)"; rc=$?
if [ "$rc" -eq 5 ]; then echo "  ok    exit 5 | gh falhando sempre (rede)"
else echo "  FAIL  want exit 5, got $rc | gh falhando sempre"; fail=1; fi

# check pendente NÃO pode contar como vermelho (falso-positivo)
caso "check pendente ≠ vermelho → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","state":"PENDING"}],"title":"t","url":"u"}'

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
