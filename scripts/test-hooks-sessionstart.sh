#!/usr/bin/env bash
# test-hooks-sessionstart.sh — os 2 hooks de SessionStart emitem JSON VÁLIDO
# em qualquer circunstância (hook com stdout inválido é ignorado pelo harness,
# ou pior, polui o boot da sessão — o contrato é: sempre JSON parseável).
#
# Uso: bash scripts/test-hooks-sessionstart.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOKS="$here/../.claude/hooks"
fail=0

echo "── pos-compact-ptbr.sh ──"
out="$(bash "$HOOKS/pos-compact-ptbr.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null 2>&1; then
  echo "  ok    JSON válido com hookEventName=SessionStart"
else
  echo "  FAIL  saída não é o JSON esperado: $out"; fail=1
fi
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "pt-BR"; then
  echo "  ok    contexto reforça pt-BR"
else
  echo "  FAIL  contexto sem o reforço de pt-BR"; fail=1
fi

echo "── vigia-worktree.sh ──"
# num diretório SEM package.json: não dispara install e deve emitir JSON válido ('{}' ou aviso)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
out="$(cd "$tmp" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "  ok    JSON válido fora de worktree (sem package.json)"
else
  echo "  FAIL  saída inválida fora de worktree: $out"; fail=1
fi
# num diretório COM package.json e SEM node_modules: precisa avisar (e disparar install em bg)
mkdir -p "$tmp/wt"; echo '{}' > "$tmp/wt/package.json"
out="$(cd "$tmp/wt" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' | grep -q "node_modules AUSENTE"; then
  echo "  ok    avisa node_modules ausente (e dispara install em background)"
else
  echo "  FAIL  não avisou node_modules ausente: $out"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
