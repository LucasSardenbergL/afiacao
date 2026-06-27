#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA: migration 20260627200000_fix_refresh_sku_ranking_gate_cron.sql         ║
# ║  Remove o gate auth.uid() que matava o cron. Prova:                            ║
# ║  (A1) cron-context (auth.uid()=NULL) refresca — NÃO dá 42501;                  ║
# ║  (A2) authenticated NÃO executa (REVOKE); (A3) service_role executa (GRANT).   ║
# ║  Falsifica (F1): a versão COM o gate falha sob NULL (= o bug que consertamos). ║
# ║  Rodar:  bash db/test-refresh-ranking-gate-cron.sh > /tmp/t.log 2>&1; echo $?  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="rank-gate"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "═══ setup (PG17 :$PORT) ═══"
# ZONA 1 — pré-requisitos: app_role/has_role, schema private, MV stub (o alvo do refresh)
P -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
  CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); END IF; END $$;
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
CREATE SCHEMA IF NOT EXISTS private;
-- MV alvo (stub) + índice único (exigido pelo REFRESH CONCURRENTLY)
CREATE MATERIALIZED VIEW private.mv_sku_ranking_negociacao_paralela AS SELECT g AS sku_id FROM generate_series(1,5) g;
CREATE UNIQUE INDEX mv_rank_sku_uq ON private.mv_sku_ranking_negociacao_paralela (sku_id);
SQL

# ZONA 2 — aplicar a migration REAL
MIG="$REPO_ROOT/supabase/migrations/20260627200000_fix_refresh_sku_ranking_gate_cron.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ZONA 3 — asserts
echo "── A1 CRON-CONTEXT: auth.uid()=NULL refresca (NÃO dá 42501) ──"
R=$(P -tA 2>&1 -c "SET test.uid=''; SET test.role=''; SELECT skus_ranqueados FROM public.refresh_sku_ranking_negociacao();" || true)
case "$R" in *42501*|*"Acesso negado"*) bad "A1 cron AINDA morre sob NULL: $R";; *5*) ok "A1 refresca sob auth.uid()=NULL (cron recuperado; retornou skus=$R)";; *) bad "A1 retorno inesperado: $R";; esac

echo "── A2 authenticated NÃO executa o refresh (REVOKE) ──"
R=$(P -tA 2>&1 -c "SET test.uid=''; SET ROLE authenticated; SELECT public.refresh_sku_ranking_negociacao();" || true)
case "$R" in *denied*|*permission*) ok "A2 authenticated barrado (REVOKE EXECUTE)";; *) bad "A2 authenticated executou? $R";; esac

echo "── A3 service_role executa (GRANT) ──"
R=$(P -tA 2>&1 -c "SET test.uid=''; SET ROLE service_role; SELECT public.refresh_sku_ranking_negociacao();" || true)
case "$R" in *denied*|*permission*) bad "A3 service_role barrado (grant faltando): $R";; *) ok "A3 service_role executa (GRANT EXECUTE)";; esac

# ZONA 4 — falsificação
echo "── F1: a versão COM o gate auth.uid() falha sob NULL (= o bug que consertamos) ──"
P -q -c "CREATE OR REPLACE FUNCTION public.refresh_sku_ranking_negociacao() RETURNS TABLE(skus_ranqueados integer, atualizado_em timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','private' AS \$f\$
  BEGIN IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)) THEN RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE='42501'; END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.mv_sku_ranking_negociacao_paralela; RETURN QUERY SELECT COUNT(*)::int, now() FROM private.mv_sku_ranking_negociacao_paralela; END \$f\$;"
R=$(P -tA 2>&1 -c "SET test.uid=''; SELECT public.refresh_sku_ranking_negociacao();" || true)
case "$R" in *42501*|*"Acesso negado"*) ok "F1 dente (gate auth.uid() reproduz o cron morto: 42501 sob NULL)";; *) bad "F1 não reproduziu o bug: $R";; esac
P -q -f "$MIG" >/dev/null  # restaura a versão real (sem gate)

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
