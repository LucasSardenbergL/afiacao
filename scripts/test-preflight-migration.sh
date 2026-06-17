#!/usr/bin/env bash
# test-preflight-migration.sh — TDD de scripts/wt-preflight-migration.ts
#
# Regra: uma migration que recria um OBJETO que outra migration concorrente também recria.
# Severidade depende de O QUE colide E de ONDE:
#   🔴 red    — function/view/trigger/rls_policy recriado por migration EM VOO (não-commitada,
#               noutra worktree) → concorrência real, "última a rodar vence" sobrescreve.
#   🟡 yellow — objeto benigno (table/index/enum/cron, IF NOT EXISTS / aditivo); OU colisão só
#               com migration JÁ COMMITADA (histórico → evolução serial, não concorrência);
#               OU timestamp colidido.
#   🟢 green  — sem colisão.
# Fail-open: dir de scan inexistente / sem concorrentes → green (nunca quebra).
#
# Injeção p/ teste:
#   WT_PREFLIGHT_SCAN_DIRS=dir1:dir2     substitui o `git worktree list`
#   WT_PREFLIGHT_COMMITTED=a.sql:b.sql   marca basenames como já-commitados (HEAD)
# Uso: bash scripts/test-preflight-migration.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
cli="$root/scripts/wt-preflight-migration.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/wtA/supabase/migrations" "$tmp/wtB/supabase/migrations" "$tmp/target"
cat >"$tmp/wtA/supabase/migrations/20260101000000_a.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.foo(x integer) RETURNS void AS $$ $$ LANGUAGE sql;
CREATE TABLE IF NOT EXISTS public.shared_t (id int);
SQL
cat >"$tmp/wtB/supabase/migrations/20260102000000_b.sql" <<'SQL'
CREATE OR REPLACE VIEW public.v_x AS SELECT 1;
SQL

scan="$tmp/wtA/supabase/migrations:$tmp/wtB/supabase/migrations"

verdict_of() { # <scan-dirs> <committed> <target-file>
  WT_PREFLIGHT_SCAN_DIRS="$1" WT_PREFLIGHT_COMMITTED="$2" bun "$cli" "$3" --json 2>/dev/null \
    | sed -n 's/.*"verdict"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -1
}

fail=0
expect() { # <scan> <committed> <target> <want> <desc>
  local got
  got="$(verdict_of "$1" "$2" "$3")"
  if [ "$got" = "$4" ]; then echo "  ok    $5 ($got)"
  else echo "  FAIL  $5 — want $4 got '${got:-<vazio>}'"; fail=1; fi
}

echo "── colisão de objeto perigoso EM VOO → red ──"
cat >"$tmp/target/red_fn.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.foo(x integer) RETURNS int AS $$ select 1 $$ LANGUAGE sql;
SQL
expect "$scan" "" "$tmp/target/red_fn.sql" red "função recriada por worktree concorrente"

cat >"$tmp/target/red_view.sql" <<'SQL'
CREATE OR REPLACE VIEW public.v_x AS SELECT 2;
SQL
expect "$scan" "" "$tmp/target/red_view.sql" red "view recriada por worktree concorrente"

echo "── colisão só com migration JÁ COMMITADA → yellow (evolução serial) ──"
expect "$scan" "20260101000000_a.sql" "$tmp/target/red_fn.sql" yellow "função já no histórico (não é concorrência)"

echo "── colisão benigna / aditiva → yellow ──"
cat >"$tmp/target/yellow_tbl.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS public.shared_t (id int, extra text);
SQL
expect "$scan" "" "$tmp/target/yellow_tbl.sql" yellow "table compartilhada (IF NOT EXISTS)"

echo "── sem colisão → green ──"
cat >"$tmp/target/green_overload.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.foo(x text) RETURNS void AS $$ $$ LANGUAGE sql;
SQL
expect "$scan" "" "$tmp/target/green_overload.sql" green "overload foo(text) ≠ foo(integer)"

cat >"$tmp/target/green_new.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.brand_new(a int) RETURNS void AS $$ $$ LANGUAGE sql;
SQL
expect "$scan" "" "$tmp/target/green_new.sql" green "objeto inédito"

echo "── fail-open ──"
expect "" "" "$tmp/target/red_fn.sql" green "sem concorrentes (scan vazio)"
expect "/nao/existe/xyz" "" "$tmp/target/red_fn.sql" green "dir de scan inexistente não quebra"

echo
if [ "$fail" -eq 0 ]; then echo "PASS — wt-preflight-migration"; else echo "FALHOU"; fi
exit "$fail"
