#!/usr/bin/env bash
# test-migration-immutability-guard.sh — TDD do hook .claude/hooks/migration-immutability-guard.sh
#
# Regra: Write/Edit/MultiEdit de supabase/migrations/*.sql que JÁ existe no HEAD (committed) → deny.
# Migration nova (untracked), arquivo fora de migrations, ou fora de repo git → allow (fail-open).
#
# Uso: bash scripts/test-migration-immutability-guard.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/migration-immutability-guard.sh"

command -v git >/dev/null 2>&1 || { echo "SKIP — git ausente"; exit 0; }
command -v jq  >/dev/null 2>&1 || { echo "SKIP — jq ausente";  exit 0; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# repo com UMA migration committed + um arquivo committed fora de migrations
repo="$tmp/repo"
mkdir -p "$repo/supabase/migrations" "$repo/src"
( cd "$repo" || exit 1
  git init -q
  git config user.email t@t.t; git config user.name t
  echo "CREATE TABLE a();"   > supabase/migrations/20260101000000_committed.sql
  echo "export const x = 1;" > src/foo.ts
  git add -A; git commit -qm init )
# migration NOVA, ainda não commitada (fluxo lovable-db-operator)
echo "CREATE TABLE b();" > "$repo/supabase/migrations/20260202000000_new.sql"

run() { # <file_path> <tool> → stdout do hook, com CLAUDE_PROJECT_DIR apontando pro repo
  local fp="$1" tool="${2:-Edit}"
  printf '{"tool_name":"%s","tool_input":{"file_path":"%s","new_string":"x","content":"x"}}' "$tool" "$fp" \
    | CLAUDE_PROJECT_DIR="$repo" bash "$HOOK" 2>/dev/null
}
is_deny() { grep -q '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; }

fail=0
expect_deny()  { if run "$1" "${3:-Edit}" | is_deny; then echo "  ok    deny  | $2"; else echo "  FAIL  want deny  | $2"; fail=1; fi; }
expect_allow() { if run "$1" "${3:-Edit}" | is_deny; then echo "  FAIL  want allow | $2"; fail=1; else echo "  ok    allow | $2"; fi; }

echo "── modificar migration committed → deny ──"
expect_deny  "$repo/supabase/migrations/20260101000000_committed.sql" "Edit de migration no HEAD"            Edit
expect_deny  "$repo/supabase/migrations/20260101000000_committed.sql" "Write (overwrite) de migration no HEAD" Write
expect_deny  "$repo/supabase/migrations/20260101000000_committed.sql" "MultiEdit de migration no HEAD"        MultiEdit

echo "── fluxo legítimo / fora de escopo → allow ──"
expect_allow "$repo/supabase/migrations/20260202000000_new.sql" "migration nova, untracked (lovable-db-operator)" Write
expect_allow "$repo/src/foo.ts"                                  "arquivo committed fora de migrations"           Edit
expect_allow "$repo/supabase/migrations/20260303000000_inexistente.sql" "migration que nem existe ainda"        Edit

echo "── bypass de path normalizado (Codex 2026-06-24) → deny ──"
expect_deny "./supabase/migrations/20260101000000_committed.sql" "path com ./ (resolve relativo ao root)" Edit
# CLAUDE_PROJECT_DIR divergente do toplevel: rel tem de vir do git toplevel, não do prefixo textual
if printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","new_string":"x"}}' \
     "$repo/supabase/migrations/20260101000000_committed.sql" \
   | CLAUDE_PROJECT_DIR="$repo/src" bash "$HOOK" 2>/dev/null | is_deny
then echo "  ok    deny  | CLAUDE_PROJECT_DIR=subdir divergente do git toplevel"
else echo "  FAIL  want deny  | CLAUDE_PROJECT_DIR=subdir"; fail=1; fi
# acesso via symlink pro repo: pwd -P resolve pro físico sob o toplevel
ln -s "$repo" "$tmp/link" 2>/dev/null
if printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","new_string":"x"}}' \
     "$tmp/link/supabase/migrations/20260101000000_committed.sql" \
   | CLAUDE_PROJECT_DIR="$tmp/link" bash "$HOOK" 2>/dev/null | is_deny
then echo "  ok    deny  | acesso via symlink pro repo"
else echo "  FAIL  want deny  | symlink pro repo"; fail=1; fi

echo "── fail-open: fora de repo git → allow ──"
mkdir -p "$tmp/nogit/supabase/migrations"
echo "x" > "$tmp/nogit/supabase/migrations/20260101000000_committed.sql"
if printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","new_string":"x"}}' \
     "$tmp/nogit/supabase/migrations/20260101000000_committed.sql" \
   | CLAUDE_PROJECT_DIR="$tmp/nogit" bash "$HOOK" 2>/dev/null | is_deny
then echo "  FAIL  want allow | sem repo git deveria fail-open"; fail=1
else echo "  ok    allow | sem repo git → fail-open"; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — migration-immutability-guard"; else echo "FALHOU"; fi
exit "$fail"
