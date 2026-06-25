#!/usr/bin/env bash
# test-stop-moneypath-nudge.sh — TDD do hook .claude/hooks/stop-moneypath-nudge.sh
#
# Regra: se há arquivo money-path (supabase/ ou src/ financeiro/pricing/…) uncommitted → emite
# systemMessage (nudge). Sem money-path tocado, ou repo limpo, ou sem git → silêncio (exit 0).
# NUNCA bloqueia (não emite decision:block).
#
# Uso: bash scripts/test-stop-moneypath-nudge.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/stop-moneypath-nudge.sh"
command -v git >/dev/null 2>&1 || { echo "SKIP — git ausente"; exit 0; }
command -v jq  >/dev/null 2>&1 || { echo "SKIP — jq ausente";  exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"; mkdir -p "$repo"
( cd "$repo" || exit 1
  git init -q; git config user.email t@t.t; git config user.name t
  echo "# repo" > README.md; git add -A; git commit -qm init )

run() { printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$repo" bash "$HOOK" 2>/dev/null; }
has_msg()   { grep -q 'systemMessage'; }
is_block()  { grep -q '"decision"[[:space:]]*:[[:space:]]*"block"'; }
has_ctx()   { grep -q 'additionalContext'; }
has_stopevt(){ grep -q '"hookEventName"[[:space:]]*:[[:space:]]*"Stop"'; }

fail=0
mk() { mkdir -p "$repo/$(dirname "$1")"; echo "x" > "$repo/$1"; }
clean() { ( cd "$repo" && git clean -fdq && git checkout -q -- . 2>/dev/null ); }

want_msg()   { clean; mk "$1"; out="$(run)"; if printf '%s' "$out" | has_msg && printf '%s' "$out" | has_ctx && printf '%s' "$out" | has_stopevt && ! printf '%s' "$out" | is_block; then echo "  ok    nudge(msg+ctx) | $1"; else echo "  FAIL  want msg+ctx, no-block | $1"; fail=1; fi; }
want_quiet() { clean; mk "$1"; out="$(run)"; if printf '%s' "$out" | has_msg || printf '%s' "$out" | has_ctx; then echo "  FAIL  want quiet | $1"; fail=1; else echo "  ok    quiet | $1"; fi; }

echo "── money-path tocado → nudge ──"
want_msg "supabase/migrations/20260101000000_x.sql"
want_msg "supabase/functions/omie-sync/index.ts"
want_msg "src/pages/financeiro/Dre.tsx"
want_msg "src/hooks/useReposicaoEstoque.ts"

echo "── fora do money-path / limpo → silêncio ──"
want_quiet "src/components/ui/Botao.tsx"
want_quiet "docs/agent/foo.md"
clean; if run | has_msg; then echo "  FAIL  want quiet | repo limpo"; fail=1; else echo "  ok    quiet | repo limpo"; fi

echo "── nunca bloqueia ──"
clean; mk "supabase/migrations/x.sql"
if run | is_block; then echo "  FAIL  nudge NÃO pode bloquear"; fail=1; else echo "  ok    não-bloqueante (sem decision:block)"; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — stop-moneypath-nudge"; else echo "FALHOU"; fi
exit "$fail"
