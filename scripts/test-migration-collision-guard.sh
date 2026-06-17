#!/usr/bin/env bash
# test-migration-collision-guard.sh — TDD do hook .claude/hooks/migration-collision-guard.sh
#
# Regra: Write/Edit de supabase/migrations/*.sql cujo conteúdo recria um objeto perigoso
# que outra worktree recria EM VOO (não-commitado) → deny. 🟡/🟢, ou fora de migrations → allow.
#
# Uso: bash scripts/test-migration-collision-guard.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/migration-collision-guard.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/wtA/supabase/migrations"
cat >"$tmp/wtA/supabase/migrations/20260101000000_a.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.foo(x integer) RETURNS void AS $$ $$ LANGUAGE sql;
SQL
export WT_PREFLIGHT_SCAN_DIRS="$tmp/wtA/supabase/migrations"

mine="$tmp/mine/supabase/migrations/20260202000000_mine.sql"

run() { # <file_path> <content>  → stdout do hook
  local fp="$1" c="$2" enc
  enc="$(printf '%s' "$c" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":%s}}' "$fp" "$enc" | bash "$HOOK" 2>/dev/null
}
is_deny() { grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; }

fail=0
expect_deny() { if run "$1" "$2" | is_deny; then echo "  ok    deny  | $3"; else echo "  FAIL  want deny  | $3"; fail=1; fi; }
expect_allow() { if run "$1" "$2" | is_deny; then echo "  FAIL  want allow | $3"; fail=1; else echo "  ok    allow | $3"; fi; }

echo "── colisão de objeto perigoso EM VOO → deny ──"
WT_PREFLIGHT_COMMITTED="" expect_deny "$mine" \
  'CREATE OR REPLACE FUNCTION public.foo(x integer) RETURNS int AS $$ select 1 $$ LANGUAGE sql;' \
  "function recriada por worktree concorrente"

echo "── não bloqueia o resto → allow ──"
WT_PREFLIGHT_COMMITTED="" expect_allow "$mine" \
  'CREATE OR REPLACE FUNCTION public.unique_fn(a int) RETURNS void AS $$ $$ LANGUAGE sql;' \
  "objeto inédito"
WT_PREFLIGHT_COMMITTED="20260101000000_a.sql" expect_allow "$mine" \
  'CREATE OR REPLACE FUNCTION public.foo(x integer) RETURNS int AS $$ select 1 $$ LANGUAGE sql;' \
  "colisão só com migration já commitada (yellow)"
WT_PREFLIGHT_COMMITTED="" expect_allow "$tmp/mine/src/foo.ts" \
  'CREATE OR REPLACE FUNCTION public.foo(x integer) RETURNS int AS $$ $$ LANGUAGE sql;' \
  "arquivo fora de supabase/migrations → no-op"

echo
if [ "$fail" -eq 0 ]; then echo "PASS — migration-collision-guard"; else echo "FALHOU"; fi
exit "$fail"
